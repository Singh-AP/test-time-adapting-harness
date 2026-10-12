import { hashSource } from "../util/hash.ts";
import { createRng, shuffle } from "../util/random.ts";
import { clip, fmt } from "../util/text.ts";
import type { Budgets, CapabilityDeps } from "./capabilities.ts";
import { evaluateHarness } from "./executor.ts";
import { failedProposal, type Proposal, type ProposalStatus, type ProposeFn, propose } from "./proposer.ts";
import { buildReport, type RevisionRecord } from "./report.ts";
import { groupAdvantages, qaReward, rgReward } from "./reward.ts";
import { screenHarness } from "./screens.ts";
import { type ScoredCandidate, type Selection, type SelectionProtocol, selectNext } from "./select.ts";
import { RunStore } from "./store.ts";
import type { EvalResult, ProposerClient, PythonRunner, Question, SolverClient, Task, Usage } from "./types.ts";
import { UsageMeter } from "./usage.ts";

export interface AdaptConfig {
	/** T: number of revision rounds. */
	rounds: number;
	/** G: proposals sampled per round. */
	proposals: number;
	protocol: SelectionProtocol;
	/** |Q_fb| per round, or the whole development pool. */
	feedbackSize: number | "all";
	/** |Q_score| per round, or the whole development pool. */
	scoringSize: number | "all";
	/** Draw Q_score disjoint from Q_fb within each round. */
	disjoint: boolean;
	attempts: number;
	maxLines: number;
	budgets: Budgets;
	concurrency: number;
	seed: number;
	evaluateHeldout: boolean;
	branchHints: boolean;
	reward: "rg" | "qa";
	/** Greedy protocol only: sample nothing when the parent already scores 1.0 on the scoring set. */
	skipPerfect?: boolean;
	/** Lessons distilled from other tasks, shown to the proposer. */
	playbook?: string;
}

export type ProtocolPreset = Omit<AdaptConfig, "budgets" | "concurrency" | "seed">;

/** Reasoning Gym protocol (App. B.1): one proposal per round, dev set for feedback and scoring, retained only if it improves. */
export const REASONING_GYM_PROTOCOL: ProtocolPreset = {
	rounds: 5,
	proposals: 1,
	protocol: "greedy",
	feedbackSize: "all",
	scoringSize: "all",
	disjoint: false,
	attempts: 3,
	maxLines: 300,
	evaluateHeldout: true,
	branchHints: false,
	reward: "rg",
	skipPerfect: true,
};

/** Multi-hop QA protocol (App. D.3): eight proposals, 6 feedback and 64 disjoint scoring questions, advance to the best. */
export const QA_PROTOCOL: ProtocolPreset = {
	rounds: 10,
	proposals: 8,
	protocol: "best-of-g",
	feedbackSize: 6,
	scoringSize: 64,
	disjoint: true,
	attempts: 1,
	maxLines: 200,
	evaluateHeldout: true,
	branchHints: false,
	reward: "qa",
	skipPerfect: false,
};

export interface AdaptDeps {
	solver: SolverClient;
	/** Model for the default single-shot proposer. */
	proposer?: ProposerClient;
	/** Alternative revision rule, for example the agentic proposer. */
	propose?: ProposeFn;
	python?: PythonRunner;
}

export interface AdaptParams {
	task: Task;
	seedSource: string;
	config: AdaptConfig;
	deps: AdaptDeps;
	runDir: string;
	log?: (line: string) => void;
	signal?: AbortSignal;
}

export interface RoleUsage extends Usage {
	calls: number;
}

export interface CandidateSummary {
	index: number;
	status: ProposalStatus;
	hash?: string;
	score: number | null;
	completedFraction: number;
	reward: number;
	advantage: number;
	attempts: number;
	summary: string;
	reason?: string;
}

export interface RoundSummary {
	round: number;
	parentHash: string;
	feedback: { size: number; score: number };
	scoring: { size: number; parentScore: number };
	candidates: CandidateSummary[];
	selection: Omit<Selection, "source"> & { hash: string };
	heldout?: number;
	usage: { solver: RoleUsage; proposer: RoleUsage };
	durationMs: number;
}

export interface AdaptSummary {
	task: string;
	runDir: string;
	seedHeldout?: number;
	finalHeldout?: number;
	rounds: RoundSummary[];
	finalHash: string;
	usage: { solver: RoleUsage; proposer: RoleUsage };
}

interface LoopState {
	version: 1;
	completedRounds: number;
	currentSource: string;
	previousSource?: string;
	history: RevisionRecord[];
	rounds: RoundSummary[];
	seedHeldout?: number;
	shownQuestions: string[];
	shownAnswers: string[];
	usage: { solver: RoleUsage; proposer: RoleUsage };
}

/** Draws Q_fb and Q_score for one round from the development pool. */
export function drawRoundSets(
	dev: readonly Question[],
	config: Pick<AdaptConfig, "feedbackSize" | "scoringSize" | "disjoint">,
	rng: () => number,
): { feedback: readonly Question[]; scoring: readonly Question[] } {
	if (config.feedbackSize === "all" && config.scoringSize === "all" && !config.disjoint)
		return { feedback: dev, scoring: dev };
	const order = shuffle(dev, rng);
	const nFeedback = config.feedbackSize === "all" ? order.length : Math.min(config.feedbackSize, order.length);
	const feedback = order.slice(0, nFeedback);
	const pool = config.disjoint ? order.slice(nFeedback) : shuffle(dev, rng);
	const nScoring = config.scoringSize === "all" ? pool.length : Math.min(config.scoringSize, pool.length);
	return { feedback, scoring: pool.slice(0, nScoring) };
}

export function meterSolver(client: SolverClient, meter: UsageMeter): SolverClient {
	return {
		complete: async (request, signal) => {
			const response = await client.complete(request, signal);
			meter.add(response.usage);
			return response;
		},
	};
}

export function meterProposer(client: ProposerClient, meter: UsageMeter): ProposerClient {
	return {
		complete: async (request, signal) => {
			const response = await client.complete(request, signal);
			meter.add(response.usage);
			return response;
		},
	};
}

/** Test-time adaptation (Eq. 4): T rounds of propose, apply, select, with held-out evaluation for reporting only. */
export async function adapt(p: AdaptParams): Promise<AdaptSummary> {
	const { task, config } = p;
	if (config.disjoint && config.feedbackSize === "all")
		throw new Error("disjoint feedback and scoring sets need a numeric feedbackSize");
	const log = p.log ?? (() => {});
	const store = new RunStore(p.runDir);
	const meters = { solver: new UsageMeter(), proposer: new UsageMeter() };
	const deps: CapabilityDeps = {
		solver: meterSolver(p.deps.solver, meters.solver),
		python: p.deps.python,
		search: task.search,
	};
	const proposer = p.deps.proposer ? meterProposer(p.deps.proposer, meters.proposer) : undefined;
	const proposeFn: ProposeFn = p.deps.propose ?? propose;
	const run = (source: string, questions: readonly Question[], label: string) =>
		evaluateHarness({
			task,
			source,
			questions,
			label,
			deps,
			budgets: config.budgets,
			concurrency: config.concurrency,
			signal: p.signal,
		});
	const heldoutCache = new Map<string, Promise<EvalResult>>();
	const heldout = (source: string, label: string): Promise<EvalResult> => {
		const key = hashSource(source);
		let pending = heldoutCache.get(key);
		if (!pending) {
			pending = run(source, task.heldout, label);
			heldoutCache.set(key, pending);
		}
		return pending;
	};
	const snapshot = () => ({ solver: meters.solver.snapshot(), proposer: meters.proposer.snapshot() });

	let state = await store.readJson<LoopState>("state.json");
	if (state) {
		log(`resuming ${p.runDir} after round ${state.completedRounds}`);
	} else {
		await store.writeJson("config.json", {
			task: {
				name: task.name,
				description: task.description,
				capabilities: task.capabilities,
				dev: task.dev.length,
				heldout: task.heldout.length,
			},
			config,
		});
		await store.writeText("seed.js", p.seedSource);
		state = {
			version: 1,
			completedRounds: 0,
			currentSource: p.seedSource,
			history: [],
			rounds: [],
			shownQuestions: [],
			shownAnswers: [],
			usage: { solver: zeroRole(), proposer: zeroRole() },
		};
		if (config.evaluateHeldout && task.heldout.length > 0) {
			const before = snapshot();
			const seedHeldout = await heldout(p.seedSource, "round-00/heldout");
			await store.writeEval("round-00/heldout", seedHeldout);
			state.seedHeldout = seedHeldout.mean;
			state.usage = addRoles(state.usage, deltaRoles(snapshot(), before));
			log(`seed held-out ${fmt(seedHeldout.mean)} on ${task.heldout.length} questions`);
		}
		await store.writeJson("state.json", state);
	}

	for (let round = state.completedRounds + 1; round <= config.rounds; round++) {
		p.signal?.throwIfAborted();
		const started = Date.now();
		const before = snapshot();
		const dir = `round-${String(round).padStart(2, "0")}`;
		const parentSource = state.currentSource;
		const parentHash = hashSource(parentSource);
		const { feedback, scoring } = drawRoundSets(task.dev, config, createRng(config.seed * 7919 + round));
		if (scoring.length === 0) throw new Error("the scoring set is empty; enlarge the development pool");
		const feedbackEval = await run(parentSource, feedback, `${dir}/feedback`);
		await store.writeEval(`${dir}/feedback`, feedbackEval);
		const parentScoreEval =
			scoring === feedback ? feedbackEval : await run(parentSource, scoring, `${dir}/parent-score`);
		if (parentScoreEval !== feedbackEval) await store.writeEval(`${dir}/parent-score`, parentScoreEval);

		const report = buildReport({
			task,
			result: feedbackEval,
			questions: feedback,
			currentSource: parentSource,
			previousSource: state.previousSource,
			history: state.history,
		});
		await store.writeText(`${dir}/report.md`, report);
		for (const q of feedback) {
			if (!state.shownQuestions.includes(q.prompt)) state.shownQuestions.push(q.prompt);
			if (!state.shownAnswers.includes(q.answer)) state.shownAnswers.push(q.answer);
		}
		const shownQuestions = [...state.shownQuestions];
		const shownAnswers = [...state.shownAnswers];
		const screen = (source: string) =>
			screenHarness(source, { maxLines: config.maxLines, shownQuestions, shownAnswers });
		const perfect = config.protocol === "greedy" && config.skipPerfect === true && parentScoreEval.mean >= 1 - 1e-9;
		log(
			`round ${round}: parent ${parentHash} feedback ${fmt(feedbackEval.mean)} (${feedback.length}q), scoring ${fmt(parentScoreEval.mean)} (${scoring.length}q); sampling ${perfect ? 0 : config.proposals} proposal(s)`,
		);

		const proposals = await Promise.all(
			Array.from({ length: perfect ? 0 : config.proposals }, (_, index) =>
				proposeFn({
					client: proposer,
					task,
					capabilities: task.capabilities,
					budgets: config.budgets,
					parentSource,
					parentScore: feedbackEval.mean,
					feedbackSize: feedback.length,
					report,
					maxLines: config.maxLines,
					attempts: config.attempts,
					branch: config.branchHints && config.proposals > 1 ? { index, total: config.proposals } : undefined,
					playbook: config.playbook,
					screen,
					feedback: { task, questions: feedback, deps, concurrency: config.concurrency },
					signal: p.signal,
				}).catch((error: unknown) => failedProposal(error)),
			),
		);
		if (p.deps.propose) for (const proposal of proposals) meters.proposer.add(proposal.usage);

		const roundEvals = new Map<string, Promise<EvalResult>>();
		const scored = await Promise.all(
			proposals.map(async (proposal, index): Promise<{ proposal: Proposal; candidate: ScoredCandidate }> => {
				const cdir = `${dir}/candidates/c${index}`;
				await store.writeJson(`${cdir}/proposal.json`, {
					...proposal,
					source: undefined,
					system: undefined,
					transcript: undefined,
				});
				await store.writeText(`${cdir}/transcript.md`, renderTranscript(proposal));
				await store.writeJson(`${cdir}/transcript.json`, {
					system: proposal.system,
					messages: proposal.transcript,
				});
				if (proposal.status === "invalid") {
					return {
						proposal,
						candidate: { index, status: "invalid", source: null, score: null, completedFraction: 0 },
					};
				}
				if (proposal.status === "no_change") {
					return {
						proposal,
						candidate: {
							index,
							status: "no_change",
							source: parentSource,
							score: parentScoreEval.mean,
							completedFraction: parentScoreEval.completedFraction,
						},
					};
				}
				const source = proposal.source as string;
				await store.writeText(`${cdir}/harness.js`, source);
				const key = hashSource(source);
				let pending = roundEvals.get(key);
				if (!pending) {
					pending = run(source, scoring, `${cdir}/score`);
					roundEvals.set(key, pending);
				}
				const result = await pending;
				await store.writeEval(`${cdir}/score`, result);
				return {
					proposal,
					candidate: {
						index,
						status: "edit",
						source,
						score: result.mean,
						completedFraction: result.completedFraction,
					},
				};
			}),
		);

		const selection = perfect
			? {
					source: parentSource,
					score: parentScoreEval.mean,
					chosen: null,
					reason: `parent is perfect on the scoring set (${fmt(parentScoreEval.mean)}); no proposals sampled`,
				}
			: selectNext(
					config.protocol,
					{ source: parentSource, score: parentScoreEval.mean },
					scored.map((s) => s.candidate),
				);
		const rewards = scored.map(({ proposal, candidate }) =>
			config.reward === "rg"
				? rgReward({
						parsed: proposal.parsed || proposal.status === "no_change",
						applied: candidate.status !== "invalid",
						completedFraction: candidate.completedFraction,
						score: candidate.score ?? 0,
					})
				: qaReward({
						valid: candidate.status !== "invalid" && candidate.completedFraction > 0,
						score: candidate.score ?? 0,
					}),
		);
		const advantages = groupAdvantages(rewards);
		const candidates: CandidateSummary[] = scored.map(({ proposal, candidate }, i) => ({
			index: candidate.index,
			status: candidate.status,
			hash: candidate.status === "edit" && candidate.source ? hashSource(candidate.source) : undefined,
			score: candidate.score,
			completedFraction: candidate.completedFraction,
			reward: rewards[i],
			advantage: advantages[i],
			attempts: proposal.attempts,
			summary: summarizeProposal(proposal),
			reason: proposal.status === "edit" ? undefined : proposal.reason,
		}));
		for (const c of candidates) {
			state.history.push({
				round,
				candidate: c.index,
				status: c.status === "edit" ? (selection.chosen === c.index ? "accepted" : "rejected") : c.status,
				score: c.score,
				parentScore: parentScoreEval.mean,
				summary: c.status === "invalid" ? `invalid: ${c.reason ?? ""}` : c.summary,
			});
		}
		if (selection.chosen !== null) {
			state.previousSource = parentSource;
			state.currentSource = selection.source;
		}
		await store.writeText(`${dir}/selected.js`, state.currentSource);

		let heldoutScore: number | undefined;
		if (config.evaluateHeldout && task.heldout.length > 0) {
			const result = await heldout(state.currentSource, `${dir}/heldout`);
			await store.writeEval(`${dir}/heldout`, result);
			heldoutScore = result.mean;
		}
		const roundUsage = deltaRoles(snapshot(), before);
		const summary: RoundSummary = {
			round,
			parentHash,
			feedback: { size: feedback.length, score: feedbackEval.mean },
			scoring: { size: scoring.length, parentScore: parentScoreEval.mean },
			candidates,
			selection: {
				score: selection.score,
				chosen: selection.chosen,
				reason: selection.reason,
				hash: hashSource(state.currentSource),
			},
			heldout: heldoutScore,
			usage: roundUsage,
			durationMs: Date.now() - started,
		};
		state.rounds.push(summary);
		state.usage = addRoles(state.usage, roundUsage);
		state.completedRounds = round;
		await store.writeJson(`${dir}/round.json`, summary);
		await store.writeJson("state.json", state);
		log(`round ${round}: ${selection.reason}${heldoutScore === undefined ? "" : `; held-out ${fmt(heldoutScore)}`}`);
	}

	const last = state.rounds[state.rounds.length - 1];
	const result: AdaptSummary = {
		task: task.name,
		runDir: p.runDir,
		seedHeldout: state.seedHeldout,
		finalHeldout: last?.heldout ?? state.seedHeldout,
		rounds: state.rounds,
		finalHash: hashSource(state.currentSource),
		usage: state.usage,
	};
	await store.writeText("final.js", state.currentSource);
	await store.writeJson("summary.json", result);
	await store.writeText("summary.md", renderSummary(result));
	return result;
}

export function zeroRole(): RoleUsage {
	return { input: 0, output: 0, cost: 0, calls: 0 };
}

function addRole(a: RoleUsage, b: RoleUsage): RoleUsage {
	return { input: a.input + b.input, output: a.output + b.output, cost: a.cost + b.cost, calls: a.calls + b.calls };
}

function addRoles(a: { solver: RoleUsage; proposer: RoleUsage }, b: { solver: RoleUsage; proposer: RoleUsage }) {
	return { solver: addRole(a.solver, b.solver), proposer: addRole(a.proposer, b.proposer) };
}

function deltaRoles(
	after: { solver: RoleUsage; proposer: RoleUsage },
	before: { solver: RoleUsage; proposer: RoleUsage },
) {
	const delta = (x: RoleUsage, y: RoleUsage): RoleUsage => ({
		input: x.input - y.input,
		output: x.output - y.output,
		cost: x.cost - y.cost,
		calls: x.calls - y.calls,
	});
	return { solver: delta(after.solver, before.solver), proposer: delta(after.proposer, before.proposer) };
}

export function summarizeProposal(proposal: Proposal): string {
	return clip((proposal.manifest ?? proposal.diagnosis ?? proposal.reason ?? "").replace(/\s+/g, " ").trim(), 300);
}

export function renderTranscript(proposal: Proposal): string {
	const parts = [
		`# Proposal: ${proposal.status} after ${proposal.attempts} attempt(s)`,
		`## System\n${proposal.system}`,
	];
	proposal.transcript.forEach((m, i) => {
		parts.push(`## ${i + 1}. ${m.role}\n${m.content}`);
	});
	if (proposal.errors.length > 0) parts.push(`## Errors\n${proposal.errors.map((e) => `- ${e}`).join("\n")}`);
	return parts.join("\n\n");
}

export function renderUsage(role: string, usage: RoleUsage): string {
	return `${role}: ${usage.calls} calls, ${usage.input} input / ${usage.output} output tokens, $${usage.cost.toFixed(3)}`;
}

function renderSummary(s: AdaptSummary): string {
	const score = (x: number | undefined) => (x === undefined ? "–" : fmt(x));
	const rows = s.rounds.map((r) => {
		const candidates = r.candidates.map((c) => `${c.status}:${c.score === null ? "–" : fmt(c.score)}`).join(", ");
		const selected = r.selection.chosen === null ? "parent kept" : `candidate ${r.selection.chosen}`;
		return `| ${r.round} | ${fmt(r.feedback.score)} | ${fmt(r.scoring.parentScore)} | ${candidates} | ${selected} | ${score(r.heldout)} |`;
	});
	const delta =
		s.seedHeldout !== undefined && s.finalHeldout !== undefined
			? ` (${s.finalHeldout - s.seedHeldout >= 0 ? "+" : ""}${fmt(s.finalHeldout - s.seedHeldout)})`
			: "";
	return [
		`# Adaptation run: ${s.task}`,
		`Held-out: seed ${score(s.seedHeldout)} -> final ${score(s.finalHeldout)}${delta}. Final harness ${s.finalHash}.`,
		"",
		"| Round | Parent feedback | Parent scoring | Candidates (status:score) | Selected | Held-out |",
		"|---|---|---|---|---|---|",
		...rows,
		"",
		renderUsage("Solver", s.usage.solver),
		"",
		renderUsage("Proposer", s.usage.proposer),
		"",
	].join("\n");
}
