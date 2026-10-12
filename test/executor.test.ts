import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { evaluateHarness } from "../src/core/executor.ts";
import type { Task } from "../src/core/types.ts";
import { createArithmeticTask } from "../src/tasks/toy.ts";
import { stubPython, stubSolver, sumInPrompt } from "./helpers.ts";

const SEED = `
async function solve(question) {
	const reply = await llm(question);
	return reply.trim();
}`;

describe("evaluateHarness", () => {
	test("scores answers and summarizes outcomes", async () => {
		const task = createArithmeticTask({ dev: 6, heldout: 4, seed: 3 });
		let call = 0;
		const solver = stubSolver((request) => {
			call++;
			const sum = sumInPrompt(request.messages[0].content) ?? 0;
			return String(call % 2 === 0 ? sum : sum + 1);
		});
		const result = await evaluateHarness({
			task,
			source: SEED,
			questions: task.dev,
			label: "dev",
			deps: { solver, python: stubPython() },
			budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 },
			concurrency: 1,
		});
		expect(result.outcomes).toHaveLength(6);
		expect(result.mean).toBeCloseTo(0.5);
		expect(result.counts.correct).toBe(3);
		expect(result.counts.wrong).toBe(3);
		expect(result.completedFraction).toBe(1);
		expect(result.calls.llm).toBe(6);
		expect(result.harnessHash).toHaveLength(12);
	});

	test("grader exceptions score zero without failing the evaluation", async () => {
		const base = createArithmeticTask({ dev: 2, heldout: 1 });
		const task: Task = {
			...base,
			grade: async () => {
				throw new Error("scorer crashed");
			},
		};
		const result = await evaluateHarness({
			task,
			source: SEED,
			questions: task.dev,
			label: "dev",
			deps: { solver: stubSolver(() => "1"), python: stubPython() },
			budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 },
			concurrency: 2,
		});
		expect(result.mean).toBe(0);
		expect(result.outcomes[0].gradeDetail).toContain("scorer crashed");
		expect(result.outcomes[0].kind).toBe("wrong");
	});

	test("harness errors are counted and lower completedFraction", async () => {
		const task = createArithmeticTask({ dev: 3, heldout: 1 });
		const result = await evaluateHarness({
			task,
			source: `async function solve(q) { if (q.includes("+")) throw new Error("boom"); return "x"; }`,
			questions: task.dev,
			label: "dev",
			deps: { solver: stubSolver(() => "1"), python: stubPython() },
			budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 },
			concurrency: 3,
		});
		expect(result.counts.error).toBe(3);
		expect(result.completedFraction).toBe(0);
		expect(result.outcomes[0].error).toContain("boom");
	});
});

describe("createArithmeticTask", () => {
	test("is deterministic with disjoint ids", () => {
		const a = createArithmeticTask({ dev: 3, heldout: 3, seed: 5 });
		const b = createArithmeticTask({ dev: 3, heldout: 3, seed: 5 });
		expect(a.dev.map((q) => q.prompt)).toEqual(b.dev.map((q) => q.prompt));
		const ids = new Set([...a.dev, ...a.heldout].map((q) => q.id));
		expect(ids.size).toBe(6);
	});
});
