import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { revisionPrompt } from "../src/core/prompts.ts";
import { collectEpisodes, distillPlaybook, playbookRequest } from "../src/learning/playbook.ts";
import { stubProposer } from "./helpers.ts";

async function fakeRun(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "tta-pb-"));
	await writeFile(join(dir, "config.json"), JSON.stringify({ task: { name: "rg:maze" } }));
	await mkdir(join(dir, "round-01"), { recursive: true });
	await writeFile(
		join(dir, "round-01", "round.json"),
		JSON.stringify({
			round: 1,
			scoring: { parentScore: 0.2 },
			candidates: [{ index: 0, status: "edit", score: 0.9, summary: "Parse the grid and run BFS" }],
			selection: { chosen: 0 },
		}),
	);
	return dir;
}

describe("playbook", () => {
	test("episodes come from proposals and round summaries only", async () => {
		const episodes = await collectEpisodes([await fakeRun()]);
		expect(episodes).toEqual([
			{
				task: "rg:maze",
				round: 1,
				status: "accepted",
				parentScore: 0.2,
				score: 0.9,
				delta: 0.7,
				summary: "Parse the grid and run BFS",
			},
		]);
	});

	test("distills task-agnostic lessons with a model", async () => {
		const episodes = await collectEpisodes([await fakeRun()]);
		const request = playbookRequest(episodes, 300);
		expect(request.system).toContain("task-agnostic");
		expect(request.messages[0].content).toContain("rg:maze");
		const client = stubProposer(() => "- Prefer deterministic computation when the input is fully specified.");
		expect(await distillPlaybook(client, episodes)).toContain("deterministic");
	});

	test("adds the playbook to the revision prompt only when configured", () => {
		const base = { task: { name: "t", description: "d" }, source: "s", score: 0, feedbackSize: 1, report: "r" };
		expect(revisionPrompt(base)).not.toContain("Lessons from previous adaptations");
		const withPlaybook = revisionPrompt({ ...base, playbook: "- lesson one" });
		expect(withPlaybook.match(/Lessons from previous adaptations/g)).toHaveLength(1);
		expect(withPlaybook).toContain("- lesson one");
	});
});
