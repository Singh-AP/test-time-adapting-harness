import { hashSource } from "../util/hash.ts";
import { createRng, shuffle } from "../util/random.ts";
import { fmt } from "../util/text.ts";
import type { Budgets, CapabilityDeps } from "./capabilities.ts";
import { evaluateHarness } from "./executor.ts";
import {
	type AdaptDeps,
	meterProposer,
	meterSolver,
	type RoleUsage,
	renderTranscript,
	renderUsage,
	summarizeProposal,
} from "./loop.ts";
import { type ProposalStatus, type ProposeFn, propose } from "./proposer.ts";
import { buildReport } from "./report.ts";
import { screenHarness } from "./screens.ts";
import { RunStore } from "./store.ts";
import type { EvalResult, Task } from "./types.ts";
import { UsageMeter } from "./usage.ts";

export interface IndependentConfig {
	budgets: Budgets;
	concurrency: number;
	attempts: number;
	maxLines: number;
	seed: number;
	branchHints: boolean;
	feedbackSize: number | "all";
}

export interface IndependentParams {
	task: Task;
	seedSource: string;
	proposals: number;
	deps: AdaptDeps;
	config: IndependentConfig;
	runDir: string;
	log?: (line: string) => void;
	signal?: AbortSignal;
}

export interface IndependentProposal {
	index: number;
	status: ProposalStatus;
	hash?: string;
	heldout: number;
	attempts: number;
	summary: string;
	reason?: string;
}

export interface IndependentSummary {
	task: string;
	runDir: string;
	seedFeedback: number;
	seedHeldout: number;
	proposals: IndependentProposal[];
	/** Mean held-out score over all proposals; failed edits and no-change keep the seed score. */
	mean: number;
	/** Oracle best-of-N selected on held-out scores (not a deployable rule). */
	bestOf: number;
	aboveSeed: number;
	failedRate: number;
	usage: { solver: RoleUsage; proposer: RoleUsage };
}

/** Single-step revision (App. B.1, D.4): N independent proposals from the seed and one fixed report. */
export async function independentRevisions(p: IndependentParams): Promise<IndependentSummary> {
	const { task, config } = p;
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
	const run = (source: string, label: string, questions = task.heldout) =>
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
	const cache = new Map<string, Promise<EvalResult>>();
	const heldout = (source: string, label: string) => {
		const key = hashSource(source);
		let pending = cache.get(key);
		if (!pending) {
			pending = run(source, label);
			cache.set(key, pending);
		}
		return pending;
	};

	await store.writeJson("config.json", { task: task.name, proposals: p.proposals, config });
	await store.writeText("seed.js", p.seedSource);
	const feedback =
		config.feedbackSize === "all"
			? task.dev
			: shuffle(task.dev, createRng(config.seed)).slice(0, config.feedbackSize);
	const feedbackEval = await run(p.seedSource, "seed-feedback", feedback);
	await store.writeEval("seed-feedback", feedbackEval);
	const seedHeldout = await heldout(p.seedSource, "seed-heldout");
	await store.writeEval("seed-heldout", seedHeldout);
	log(
		`seed feedback ${fmt(feedbackEval.mean)} (${feedback.length}q), held-out ${fmt(seedHeldout.mean)} (${task.heldout.length}q)`,
	);
	const report = buildReport({
		task,
		result: feedbackEval,
		questions: feedback,
		currentSource: p.seedSource,
		history: [],
	});
	await store.writeText("report.md", report);
	const shownQuestions = feedback.map((q) => q.prompt);
	const shownAnswers = feedback.map((q) => q.answer);

	const proposals = await Promise.all(
		Array.from({ length: p.proposals }, (_, index) =>
			proposeFn({
				client: proposer,
				task,
				capabilities: task.capabilities,
				budgets: config.budgets,
				parentSource: p.seedSource,
				parentScore: feedbackEval.mean,
				feedbackSize: feedback.length,
				report,
				maxLines: config.maxLines,
				attempts: config.attempts,
				branch: config.branchHints && p.proposals > 1 ? { index, total: p.proposals } : undefined,
				screen: (source) => screenHarness(source, { maxLines: config.maxLines, shownQuestions, shownAnswers }),
				feedback: { task, questions: feedback, deps, concurrency: config.concurrency },
				signal: p.signal,
			}),
		),
	);
	if (p.deps.propose) for (const proposal of proposals) meters.proposer.add(proposal.usage);
	const results = await Promise.all(
		proposals.map(async (proposal, index): Promise<IndependentProposal> => {
			const dir = `proposals/p${index}`;
			await store.writeText(`${dir}/transcript.md`, renderTranscript(proposal));
			await store.writeJson(`${dir}/transcript.json`, { system: proposal.system, messages: proposal.transcript });
			let score = seedHeldout.mean;
			let hash: string | undefined;
			if (proposal.status === "edit" && proposal.source) {
				hash = hashSource(proposal.source);
				await store.writeText(`${dir}/harness.js`, proposal.source);
				const result = await heldout(proposal.source, `${dir}/heldout`);
				await store.writeEval(`${dir}/heldout`, result);
				score = result.mean;
			}
			log(`proposal ${index}: ${proposal.status}, held-out ${fmt(score)}`);
			return {
				index,
				status: proposal.status,
				hash,
				heldout: score,
				attempts: proposal.attempts,
				summary: summarizeProposal(proposal),
				reason: proposal.status === "edit" ? undefined : proposal.reason,
			};
		}),
	);
	const scores = results.map((r) => r.heldout);
	const n = Math.max(scores.length, 1);
	const summary: IndependentSummary = {
		task: task.name,
		runDir: p.runDir,
		seedFeedback: feedbackEval.mean,
		seedHeldout: seedHeldout.mean,
		proposals: results,
		mean: scores.reduce((a, b) => a + b, 0) / n,
		bestOf: scores.length ? Math.max(...scores) : seedHeldout.mean,
		aboveSeed: scores.filter((s) => s > seedHeldout.mean).length / n,
		failedRate: results.filter((r) => r.status === "invalid").length / n,
		usage: { solver: meters.solver.snapshot(), proposer: meters.proposer.snapshot() },
	};
	await store.writeJson("summary.json", summary);
	await store.writeText(
		"summary.md",
		[
			`# Independent revisions: ${task.name}`,
			`Seed held-out ${fmt(summary.seedHeldout)}. Mean of ${results.length} proposals ${fmt(summary.mean)}, oracle best ${fmt(summary.bestOf)}, ${fmt(summary.aboveSeed * 100, 1)}% above seed, ${fmt(summary.failedRate * 100, 1)}% failed edits.`,
			"",
			"| Proposal | Status | Held-out | Change |",
			"|---|---|---|---|",
			...results.map((r) => `| ${r.index} | ${r.status} | ${fmt(r.heldout)} | ${r.summary.replace(/\|/g, "\\|")} |`),
			"",
			renderUsage("Solver", summary.usage.solver),
			"",
			renderUsage("Proposer", summary.usage.proposer),
			"",
		].join("\n"),
	);
	return summary;
}
