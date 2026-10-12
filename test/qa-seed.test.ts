import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { runHarness } from "../src/core/sandbox.ts";
import { screenHarness } from "../src/core/screens.ts";
import { createQaTask } from "../src/tasks/qa/task.ts";
import { stubSolver } from "./helpers.ts";

describe("qa seed", () => {
	test("passes screens and runs two hops within budget", async () => {
		const source = await readFile(repoPath("seeds", "qa-seed.js"), "utf8");
		expect(await screenHarness(source, { maxLines: 200 })).toEqual({ ok: true });
		const task = await createQaTask({
			name: "hotpotqa",
			dir: repoPath("test", "fixtures", "qa-mini"),
			devSize: 4,
			testSize: 2,
		});
		const solver = stubSolver((r) => {
			const last = r.messages[r.messages.length - 1].content;
			if (last.includes("search query")) return "Eiffel Tower completed";
			if (last.includes("Answer the question")) return "Answer: 1889";
			return "The Eiffel Tower is in Paris and was completed in 1889.";
		});
		const run = await runHarness({
			source,
			prompt: "In what year was the tower in the capital of France completed?",
			task,
			capabilities: task.capabilities,
			deps: { solver, search: task.search },
			budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 },
		});
		expect(run.answer).toBe("1889");
		expect(run.calls).toEqual({ llm: 4, python: 0, search: 2 });
	});
});
