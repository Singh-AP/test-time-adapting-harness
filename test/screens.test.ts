import { describe, expect, test } from "vitest";
import { containsQuestionSpecificText, findHardCodedAnswer, screenHarness } from "../src/core/screens.ts";

const OK = "async function solve(question) {\n\treturn await llm(question);\n}\n";

describe("screenHarness", () => {
	test("accepts a valid harness", async () => {
		expect(await screenHarness(OK, { maxLines: 50 })).toEqual({ ok: true });
	});

	test("rejects syntax errors and a missing solve", async () => {
		const syntax = await screenHarness("async function solve( {", { maxLines: 50 });
		expect(syntax.ok).toBe(false);
		if (!syntax.ok) expect(syntax.reason).toContain("failed to load");
		const missing = await screenHarness("function other() {}", { maxLines: 50 });
		expect(missing).toEqual({ ok: false, reason: "The harness must define async function solve(question)." });
	});

	test("rejects harnesses over the line limit", async () => {
		const result = await screenHarness(`${"// filler\n".repeat(60)}${OK}`, { maxLines: 50 });
		expect(result.ok).toBe(false);
	});

	test("rejects top-level calls to capabilities", async () => {
		const result = await screenHarness(`const x = await llm("hi");\n${OK}`, { maxLines: 50 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("not available");
	});

	test("rejects hard-coded instance answers", async () => {
		const answer = "THOSE FROM MARS OF ANY INDEED";
		const result = await screenHarness(`${OK}const KNOWN = "${answer}";\n`, {
			maxLines: 50,
			shownAnswers: [answer, "8"],
		});
		expect(result.ok).toBe(false);
	});
});

describe("hard-coding detectors", () => {
	test("short or generic answers are not flagged", () => {
		expect(findHardCodedAnswer('const words = ["mother-in-law", "8"];', ["mother-in-law", "8"])).toBeUndefined();
		expect(findHardCodedAnswer('x = "6 7 8 1 9 2 4 3 5"', ["6 7 8 1 9 2 4 3 5"])).toBe("6 7 8 1 9 2 4 3 5");
	});

	test("template text shared by questions is allowed; instance text is not", () => {
		const template = "Navigate from the start to the goal in the following maze. ";
		const q1 = `${template}Grid A: ###..##..#..###...##...#.#.#.##..##`;
		const q2 = `${template}Grid B: #.#.#.#.###...###...#..#..##.#.#.##.`;
		expect(containsQuestionSpecificText(`const P = "${template}";`, [q1, q2])).toBe(false);
		expect(containsQuestionSpecificText(`const P = "${q1}";`, [q1, q2])).toBe(true);
	});
});
