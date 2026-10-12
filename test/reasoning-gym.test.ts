import { existsSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { repoPath } from "../src/config.ts";
import { ReasoningGymBridge } from "../src/tasks/reasoning-gym/bridge.ts";
import { createReasoningGymTask } from "../src/tasks/reasoning-gym/task.ts";

const python = repoPath(".venv", "bin", "python");

describe.skipIf(!existsSync(python))("reasoning gym", () => {
	const bridge = new ReasoningGymBridge({ pythonPath: python });
	afterAll(() => bridge.close());

	test("creates a task with disjoint dev and held-out questions and grades answers", async () => {
		const task = await createReasoningGymTask({ family: "basic_arithmetic", bridge, devSize: 5, heldoutSize: 10 });
		expect(task.name).toBe("rg:basic_arithmetic");
		expect(task.dev).toHaveLength(5);
		expect(task.heldout).toHaveLength(10);
		const devPrompts = new Set(task.dev.map((q) => q.prompt));
		for (const q of task.heldout) expect(devPrompts.has(q.prompt)).toBe(false);
		const q = task.dev[0];
		expect((await task.grade(q, q.answer)).score).toBe(1);
		expect((await task.grade(q, "definitely wrong")).score).toBe(0);
		expect(task.description).toContain("basic_arithmetic");
	});

	test("reports unknown families", async () => {
		await expect(
			createReasoningGymTask({ family: "no_such_family", bridge, devSize: 1, heldoutSize: 1 }),
		).rejects.toThrow("reasoning_gym");
	});

	test("lists families", async () => {
		expect(await bridge.families()).toContain("maze");
	});
});
