import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { runHarness } from "../src/core/sandbox.ts";
import { screenHarness } from "../src/core/screens.ts";
import { createTask } from "../src/tasks/registry.ts";
import { stubPython, stubSolver, TOY_INFO } from "./helpers.ts";

const budgets = { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 };
const seed = (name: string) => readFile(repoPath("seeds", name), "utf8");

describe("seed harnesses", () => {
	test("load and pass screens", async () => {
		for (const name of ["rg-seed.js", "tool-loop.js"]) {
			expect(await screenHarness(await seed(name), { maxLines: 300 })).toEqual({ ok: true });
		}
	});

	test("rg-seed makes one call and extracts the last answer", async () => {
		const solver = stubSolver(() => "Thinking.\nAnswer: wrong\nAnswer: 42");
		const run = await runHarness({
			source: await seed("rg-seed.js"),
			prompt: "q",
			task: TOY_INFO,
			capabilities: ["llm"],
			deps: { solver },
			budgets,
		});
		expect(run.answer).toBe("42");
		expect(solver.requests).toHaveLength(1);
	});

	test("tool-loop runs python and then answers", async () => {
		const solver = stubSolver((r) =>
			r.messages.length === 1
				? "```python\nprint(2 + 3)\n```"
				: `Answer: ${/\d+/.exec(r.messages[r.messages.length - 1].content)?.[0]}`,
		);
		const run = await runHarness({
			source: await seed("tool-loop.js"),
			prompt: "What is 2 + 3?",
			task: TOY_INFO,
			capabilities: ["llm", "python"],
			deps: { solver, python: stubPython() },
			budgets,
		});
		expect(run.answer).toBe("5");
	});
});

describe("createTask", () => {
	test("builds the toy task and rejects unknown specs", async () => {
		expect((await createTask("toy:addition", { devSize: 3, heldoutSize: 2 })).dev).toHaveLength(3);
		await expect(createTask("nope:x")).rejects.toThrow("Unknown task");
	});
});
