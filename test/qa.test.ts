import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoPath } from "../src/config.ts";
import type { QuestionOutcome } from "../src/core/types.ts";
import { exactMatch, f1Score, normalizeAnswer } from "../src/tasks/qa/grading.ts";
import { createQaTask, stratifiedSplit } from "../src/tasks/qa/task.ts";
import { createRng } from "../src/util/random.ts";

const fixture = repoPath("test", "fixtures", "qa-mini");

describe("grading", () => {
	test("normalizes like SQuAD", () => {
		expect(normalizeAnswer("The  Eiffel-Tower!")).toBe("eiffeltower");
		expect(normalizeAnswer("An apple a day")).toBe("apple day");
		expect(exactMatch("the French", ["French"])).toBe(true);
		expect(exactMatch("Derrickson.", ["Scott Derrickson", "Derrickson"])).toBe(true);
		expect(exactMatch("The answer is Paris.", ["Paris"])).toBe(false);
		expect(f1Score("The answer is Paris", "Paris")).toBeCloseTo(0.5);
	});
});

describe("stratifiedSplit", () => {
	test("splits disjointly and stratified", () => {
		const records = Array.from({ length: 40 }, (_, i) => ({ id: `q${i}`, type: i < 30 ? "a" : "b" }));
		const { dev, test } = stratifiedSplit(records, 20, 8, createRng(1));
		expect(dev).toHaveLength(20);
		expect(test).toHaveLength(8);
		expect(dev.filter((r) => r.type === "b")).toHaveLength(5);
		const ids = new Set(dev.map((r) => r.id));
		for (const r of test) expect(ids.has(r.id)).toBe(false);
	});
});

describe("createQaTask", () => {
	test("loads a corpus, searches it, grades with aliases and describes supporting documents", async () => {
		const task = await createQaTask({ name: "hotpotqa", dir: fixture, devSize: 4, testSize: 2, seed: 1 });
		expect(task.name).toBe("qa:hotpotqa");
		expect(task.capabilities).toEqual(["llm", "search"]);
		expect(task.dev).toHaveLength(4);
		expect(task.heldout).toHaveLength(2);
		const hits = await task.search?.search("Doctor Strange director", 1);
		expect(hits?.[0].title).toBe("Doctor Strange (2016 film)");
		const q1 = [...task.dev, ...task.heldout].find((q) => q.id === "q1");
		if (!q1) throw new Error("q1 missing");
		expect((await task.grade(q1, "derrickson")).score).toBe(1);
		const wrong = await task.grade(q1, "James Gunn");
		expect(wrong.score).toBe(0);
		expect(wrong.detail).toContain("F1");
		const outcome: QuestionOutcome = {
			questionId: "q1",
			answer: "x",
			score: 0,
			kind: "wrong",
			durationMs: 1,
			calls: { llm: 1, python: 0, search: 1 },
			usage: { input: 0, output: 0, cost: 0 },
			trace: [{ tool: "search", at: 0, durationMs: 1, input: "q", output: "Paris | Doctor Strange (2016 film)" }],
		};
		expect(task.describeOutcome?.(q1, outcome)).toBe(
			'Supporting documents: retrieved ["Doctor Strange (2016 film)"], missed none.',
		);
	});
});

const python = repoPath(".venv", "bin", "python");
describe.skipIf(!existsSync(python))("prepare_qa.py", () => {
	test("deduplicates the corpus", () => {
		const out = mkdtempSync(join(tmpdir(), "tta-qa-"));
		const src = join(out, "in.jsonl");
		const rows = [
			{
				id: "a",
				question: "Q1?",
				answer: "x",
				type: "bridge",
				supporting_facts: { title: ["T1"], sent_id: [0] },
				context: { title: ["T1", "T2"], sentences: [["One."], ["Two."]] },
			},
			{
				id: "b",
				question: "Q2?",
				answer: "y",
				type: "comparison",
				supporting_facts: { title: ["T2"], sent_id: [0] },
				context: { title: ["T2", "T3"], sentences: [["Two."], ["Three."]] },
			},
		];
		writeFileSync(src, rows.map((r) => JSON.stringify(r)).join("\n"));
		execFileSync(python, ["-I", repoPath("python", "prepare_qa.py"), "hotpotqa", src, out]);
		const corpus = readFileSync(join(out, "corpus.jsonl"), "utf8").trim().split("\n");
		expect(corpus).toHaveLength(3);
		const questions = readFileSync(join(out, "questions.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(questions[1]).toMatchObject({ id: "b", answer: "y", supporting_titles: ["T2"], type: "comparison" });
	});
});
