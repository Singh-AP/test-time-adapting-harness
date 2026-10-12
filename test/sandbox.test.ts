import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS, normalizeSolverRequest } from "../src/core/capabilities.ts";
import { runHarness } from "../src/core/sandbox.ts";
import { stubPython, stubSolver, TOY_INFO } from "./helpers.ts";

const budgets = { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 };

function run(source: string, prompt = "What is 2 + 3?", overrides: Partial<typeof budgets> = {}) {
	const solver = stubSolver((request) => `Reasoning...\nAnswer: echo ${request.messages.at(-1)?.content.length}`);
	return runHarness({
		source,
		prompt,
		task: TOY_INFO,
		capabilities: ["llm", "python"],
		deps: { solver, python: stubPython() },
		budgets: { ...budgets, ...overrides },
	});
}

describe("runHarness", () => {
	test("runs solve with llm and records a trace", async () => {
		const result = await run(`
async function solve(question) {
	const reply = await llm({ system: "be brief", prompt: question });
	log("reply length", reply.length);
	return reply.split("Answer:").pop().trim();
}`);
		expect(result.error).toBeUndefined();
		expect(result.answer).toBe("echo 14");
		expect(result.calls.llm).toBe(1);
		expect(result.trace.map((e) => e.tool)).toEqual(["llm", "log"]);
		expect(result.trace[0].input).toContain("[system] be brief");
		expect(result.usage.input).toBe(10);
	});

	test("exposes no ambient capabilities", async () => {
		const result = await run(`
async function solve() {
	return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof TASK.name].join(",");
}`);
		expect(result.answer).toBe("undefined,undefined,undefined,undefined,string");
	});

	test("enforces the llm budget", async () => {
		const result = await run(
			`async function solve(q) { for (let i = 0; i < 5; i++) await llm(q); return "done"; }`,
			"q",
			{ llmCalls: 2 },
		);
		expect(result.answer).toBeNull();
		expect(result.error?.kind).toBe("budget");
		expect(result.error?.message).toContain("budget exhausted");
		expect(result.calls.llm).toBe(2);
	});

	test("times out an infinite loop", async () => {
		const result = await run(`async function solve() { while (true) {} }`, "q", { questionTimeoutMs: 500 });
		expect(result.error?.kind).toBe("timeout");
		expect(result.answer).toBeNull();
	});

	test("reports a missing solve function", async () => {
		const result = await run(`function answer() { return 1; }`);
		expect(result.error?.kind).toBe("script");
		expect(result.error?.message).toContain("solve");
	});

	test("coerces non-string answers to JSON", async () => {
		const result = await run(`async function solve() { return [1, "a"]; }`);
		expect(result.answer).toBe('[1,"a"]');
	});

	test("python global passes code and returns output", async () => {
		const result = await run(
			`async function solve() { const r = await python("print(2 + 3)"); return r.stdout.trim(); }`,
		);
		expect(result.answer).toBe("5");
		expect(result.trace[0].tool).toBe("python");
	});

	test("invalid llm requests surface as script errors", async () => {
		const result = await run(
			`async function solve() { return await llm({ messages: [{ role: "system", content: "x" }] }); }`,
		);
		expect(result.error?.kind).toBe("script");
		expect(result.error?.message).toContain("role");
	});
});

describe("normalizeSolverRequest", () => {
	test("merges consecutive roles and clamps parameters", () => {
		const request = normalizeSolverRequest(
			{
				system: "s",
				messages: [
					{ role: "user", content: "a" },
					{ role: "user", content: "" },
				],
				prompt: "b",
				temperature: 9,
				maxTokens: 999_999,
			},
			1000,
		);
		expect(request.messages).toEqual([{ role: "user", content: "a\n\n(empty)\n\nb" }]);
		expect(request.temperature).toBe(1.5);
		expect(request.maxTokens).toBe(1000);
		expect(request.system).toBe("s");
	});

	test("rejects an assistant-final conversation", () => {
		expect(() =>
			normalizeSolverRequest(
				{
					messages: [
						{ role: "user", content: "a" },
						{ role: "assistant", content: "b" },
					],
				},
				100,
			),
		).toThrow("last message");
	});
});
