import { describe, expect, test } from "vitest";
import { summarizeOutcomes } from "../src/core/executor.ts";
import { buildReport, pickDiverse, unifiedDiff } from "../src/core/report.ts";
import type { QuestionOutcome } from "../src/core/types.ts";
import { createArithmeticTask } from "../src/tasks/toy.ts";

function outcome(
	questionId: string,
	kind: QuestionOutcome["kind"],
	answer: string | null,
	extra: Partial<QuestionOutcome> = {},
): QuestionOutcome {
	return {
		questionId,
		answer,
		score: kind === "correct" ? 1 : 0,
		kind,
		trace: [],
		durationMs: 1200,
		calls: { llm: 1, python: 0, search: 0 },
		usage: { input: 10, output: 5, cost: 0 },
		...extra,
	};
}

describe("buildReport", () => {
	const task = createArithmeticTask({ dev: 4, heldout: 2, seed: 9 });
	const [q0, q1, q2, q3] = task.dev;
	const result = summarizeOutcomes(
		"dev",
		"abc",
		[
			outcome(q0.id, "wrong", "1", {
				trace: [
					{
						tool: "llm",
						at: 0,
						durationMs: 900,
						input: "[user] long prompt",
						output: "the reply",
						usage: { input: 50, output: 20, cost: 0 },
					},
				],
			}),
			outcome(q1.id, "error", null, { error: "TypeError: x is undefined" }),
			outcome(q2.id, "correct", q2.answer),
			outcome(q3.id, "correct", q3.answer),
		],
		5000,
	);
	const report = buildReport({
		task,
		result,
		questions: task.dev,
		currentSource: "b\n",
		previousSource: "a\n",
		history: [
			{
				round: 1,
				candidate: 0,
				status: "rejected",
				score: 0.25,
				parentScore: 0.5,
				summary: "Tried | majority vote",
			},
		],
	});

	test("summarizes scores and outcome counts", () => {
		expect(report).toContain("Score 0.500 on 4 questions");
		expect(report).toContain("correct 2");
		expect(report).toContain("error 1");
	});

	test("shows failures with question, expected answer, harness answer, trace and error", () => {
		expect(report).toContain(q0.prompt);
		expect(report).toContain(`Expected answer: "${q0.answer}"`);
		expect(report).toContain('Harness answer: "1"');
		expect(report).toContain("the reply");
		expect(report).toContain("TypeError: x is undefined");
	});

	test("includes passing examples, the diff and the revision history", () => {
		expect(report).toContain("## Passing examples");
		expect(report).toContain("-a");
		expect(report).toContain("+b");
		expect(report).toContain("Tried \\| majority vote");
	});

	test("never includes held-out questions", () => {
		for (const q of task.heldout) expect(report).not.toContain(q.prompt);
	});
});

describe("pickDiverse", () => {
	test("round-robins across failure kinds", () => {
		const picked = pickDiverse(
			[
				outcome("a", "wrong", "x"),
				outcome("b", "wrong", "x"),
				outcome("c", "error", null),
				outcome("d", "timeout", null),
			],
			3,
		);
		expect(picked.map((o) => o.questionId)).toEqual(["c", "d", "a"]);
	});
});

describe("unifiedDiff", () => {
	test("produces a unified diff without index headers", () => {
		const diff = unifiedDiff("a\nb\n", "a\nc\n");
		expect(diff).toContain("-b");
		expect(diff).toContain("+c");
		expect(diff).not.toContain("Index:");
	});
});
