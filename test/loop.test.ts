import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { independentRevisions } from "../src/core/independent.ts";
import { type AdaptConfig, adapt, drawRoundSets, QA_PROTOCOL, REASONING_GYM_PROTOCOL } from "../src/core/loop.ts";
import { createArithmeticTask } from "../src/tasks/toy.ts";
import { createRng } from "../src/util/random.ts";
import { stubProposer, stubPython, stubSolver, sumInPrompt } from "./helpers.ts";

const SEED = "async function solve(question) {\n\tconst reply = await llm(question);\n\treturn reply.trim();\n}\n";
const IMPROVE = [
	"## Diagnosis",
	"The solver is sloppy without instructions.",
	"## Edits",
	"<<<<<<< SEARCH",
	"\tconst reply = await llm(question);",
	"=======",
	'\tconst reply = await llm({ system: "CAREFUL", prompt: question });',
	">>>>>>> REPLACE",
	"## Change manifest",
	"Ask for care.",
].join("\n");
const budgets = { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 };

/** Answers correctly only when the system prompt is CAREFUL. */
const solver = () =>
	stubSolver((request) => {
		const sum = sumInPrompt(request.messages[0].content) ?? 0;
		return String(request.system === "CAREFUL" ? sum : sum + 1);
	});

function config(overrides: Partial<AdaptConfig> = {}): AdaptConfig {
	return { ...REASONING_GYM_PROTOCOL, rounds: 2, budgets, concurrency: 4, seed: 1, ...overrides };
}

describe("adapt", () => {
	test("retains an improving revision and reports held-out scores per round", async () => {
		const task = createArithmeticTask({ dev: 6, heldout: 5, seed: 11 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		const proposer = stubProposer((_, call) => (call === 1 ? IMPROVE : "NO_CHANGE: done"));
		const summary = await adapt({
			task,
			seedSource: SEED,
			config: config(),
			deps: { solver: solver(), proposer, python: stubPython() },
			runDir,
		});
		expect(summary.seedHeldout).toBe(0);
		expect(summary.rounds[0].selection.chosen).toBe(0);
		expect(summary.rounds[0].heldout).toBe(1);
		expect(summary.rounds[1].candidates).toEqual([]);
		expect(summary.finalHeldout).toBe(1);
		expect(summary.usage.proposer.calls).toBe(1);
		expect(await readFile(join(runDir, "final.js"), "utf8")).toContain("CAREFUL");
		const round1 = JSON.parse(await readFile(join(runDir, "round-01", "round.json"), "utf8"));
		expect(round1.candidates[0].score).toBe(1);
		const report2 = await readFile(join(runDir, "round-02", "report.md"), "utf8");
		expect(report2).toContain("Revision history");
		expect(report2).toContain('+\tconst reply = await llm({ system: "CAREFUL", prompt: question });');
	});

	test("never shows held-out questions to the proposer", async () => {
		const task = createArithmeticTask({ dev: 5, heldout: 5, seed: 12 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		const proposer = stubProposer(() => IMPROVE);
		await adapt({
			task,
			seedSource: SEED,
			config: {
				...QA_PROTOCOL,
				rounds: 2,
				proposals: 3,
				feedbackSize: 2,
				scoringSize: 3,
				budgets,
				concurrency: 4,
				seed: 2,
			},
			deps: { solver: solver(), proposer, python: stubPython() },
			runDir,
		});
		const seen = proposer.requests.map((r) => r.system + r.messages.map((m) => m.content).join("\n")).join("\n");
		for (const q of task.heldout) expect(seen).not.toContain(q.prompt);
		expect(proposer.requests).toHaveLength(6);
	});

	test("resumes after completed rounds", async () => {
		const task = createArithmeticTask({ dev: 4, heldout: 3, seed: 13 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		await adapt({
			task,
			seedSource: SEED,
			config: config({ rounds: 1 }),
			deps: { solver: solver(), proposer: stubProposer(() => "NO_CHANGE: wait"), python: stubPython() },
			runDir,
		});
		const second = stubProposer(() => IMPROVE);
		const summary = await adapt({
			task,
			seedSource: SEED,
			config: config({ rounds: 2 }),
			deps: { solver: solver(), proposer: second, python: stubPython() },
			runDir,
		});
		expect(second.requests).toHaveLength(1);
		expect(summary.rounds).toHaveLength(2);
		expect(summary.rounds[1].selection.chosen).toBe(0);
	});
});

describe("drawRoundSets", () => {
	test("QA protocol draws disjoint feedback and scoring sets", () => {
		const task = createArithmeticTask({ dev: 20, heldout: 1 });
		const { feedback, scoring } = drawRoundSets(
			task.dev,
			{ feedbackSize: 6, scoringSize: 10, disjoint: true },
			createRng(3),
		);
		expect(feedback).toHaveLength(6);
		expect(scoring).toHaveLength(10);
		const ids = new Set(feedback.map((q) => q.id));
		for (const q of scoring) expect(ids.has(q.id)).toBe(false);
	});

	test("RG protocol uses the whole dev set for both", () => {
		const task = createArithmeticTask({ dev: 5, heldout: 1 });
		const { feedback, scoring } = drawRoundSets(
			task.dev,
			{ feedbackSize: "all", scoringSize: "all", disjoint: false },
			createRng(3),
		);
		expect(feedback).toBe(task.dev);
		expect(scoring).toBe(task.dev);
	});
});

describe("independentRevisions", () => {
	test("scores each proposal on held-out; failed edits keep the seed score", async () => {
		const task = createArithmeticTask({ dev: 4, heldout: 4, seed: 14 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-ind-"));
		const proposer = stubProposer((_, call) => (call === 1 ? IMPROVE : "nonsense"));
		const summary = await independentRevisions({
			task,
			seedSource: SEED,
			proposals: 2,
			deps: { solver: solver(), proposer, python: stubPython() },
			config: {
				budgets,
				concurrency: 4,
				attempts: 1,
				maxLines: 300,
				seed: 1,
				branchHints: true,
				feedbackSize: "all",
			},
			runDir,
		});
		expect(summary.seedHeldout).toBe(0);
		expect(summary.proposals.map((p) => p.heldout)).toEqual([1, 0]);
		expect(summary.mean).toBeCloseTo(0.5);
		expect(summary.bestOf).toBe(1);
		expect(summary.aboveSeed).toBeCloseTo(0.5);
		expect(summary.failedRate).toBeCloseTo(0.5);
		expect(proposer.requests[1].messages[0].content).toContain("proposal 2 of 2");
	});
});

describe("pluggable proposers", () => {
	test("passes feedback context and meters proposal usage", async () => {
		const task = createArithmeticTask({ dev: 4, heldout: 3, seed: 21 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		const seen: string[][] = [];
		const summary = await adapt({
			task,
			seedSource: SEED,
			config: config({ rounds: 1 }),
			deps: {
				solver: solver(),
				python: stubPython(),
				propose: async (options) => {
					seen.push((options.feedback?.questions ?? []).map((q) => q.id));
					return {
						status: "no_change",
						reason: "custom",
						attempts: 1,
						parsed: true,
						applied: false,
						errors: [],
						system: "",
						transcript: [],
						usage: { input: 7, output: 3, cost: 0.5 },
					};
				},
			},
			runDir,
		});
		expect(seen).toEqual([task.dev.map((q) => q.id)]);
		expect(summary.usage.proposer).toMatchObject({ input: 7, output: 3, cost: 0.5, calls: 1 });
	});

	test("skips proposals when the parent is perfect", async () => {
		const task = createArithmeticTask({ dev: 4, heldout: 3, seed: 22 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		const proposer = stubProposer(() => IMPROVE);
		const summary = await adapt({
			task,
			seedSource: SEED.replace("await llm(question)", 'await llm({ system: "CAREFUL", prompt: question })'),
			config: config({ rounds: 2 }),
			deps: { solver: solver(), proposer, python: stubPython() },
			runDir,
		});
		expect(proposer.requests).toHaveLength(0);
		expect(summary.rounds[0].candidates).toEqual([]);
		expect(summary.rounds[0].selection.reason).toContain("perfect");
	});
});
