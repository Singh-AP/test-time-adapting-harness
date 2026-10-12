import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collectRollouts, exportLearningData, readTranscript, selectSft } from "../src/learning/export.ts";

async function fakeRun(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "tta-export-"));
	await writeFile(join(dir, "config.json"), JSON.stringify({ task: { name: "rg:maze" }, config: { reward: "rg" } }));
	const round = (n: number, parentScore: number, candidates: object[]) => ({
		round: n,
		parentHash: `p${n}`,
		feedback: { size: 25, score: parentScore },
		scoring: { size: 25, parentScore },
		candidates,
		selection: { score: parentScore, chosen: null, reason: "", hash: "x" },
	});
	await mkdir(join(dir, "round-01", "candidates", "c0"), { recursive: true });
	await mkdir(join(dir, "round-01", "candidates", "c1"), { recursive: true });
	await writeFile(
		join(dir, "round-01", "round.json"),
		JSON.stringify(
			round(1, 0.2, [
				{
					index: 0,
					status: "edit",
					score: 0.48,
					completedFraction: 1,
					reward: 0.78,
					advantage: 1,
					attempts: 1,
					summary: "",
				},
				{
					index: 1,
					status: "invalid",
					score: null,
					completedFraction: 0,
					reward: 0.05,
					advantage: -1,
					attempts: 3,
					summary: "",
				},
			]),
		),
	);
	await writeFile(
		join(dir, "round-01", "candidates", "c0", "transcript.json"),
		JSON.stringify({
			system: "SYS",
			messages: [
				{ role: "user", content: "CTX" },
				{ role: "assistant", content: "EDIT A" },
			],
		}),
	);
	await writeFile(
		join(dir, "round-01", "candidates", "c1", "transcript.md"),
		"# Proposal: invalid after 2 attempt(s)\n\n## System\nSYS\n\n## 1. user\nCTX\n\n## Development results\nnot a turn\n\n## 2. assistant\nBAD\n\n## 3. user\nretry\n\n## 4. assistant\nBAD AGAIN",
	);
	await mkdir(join(dir, "round-02", "candidates", "c0"), { recursive: true });
	await writeFile(
		join(dir, "round-02", "round.json"),
		JSON.stringify(
			round(2, 0.48, [
				{
					index: 0,
					status: "edit",
					score: 0.5,
					completedFraction: 1,
					reward: 0.8,
					advantage: 0,
					attempts: 1,
					summary: "",
				},
			]),
		),
	);
	await writeFile(
		join(dir, "round-02", "candidates", "c0", "transcript.json"),
		JSON.stringify({
			system: "SYS",
			messages: [
				{ role: "user", content: "CTX2" },
				{ role: "assistant", content: "EDIT B" },
			],
		}),
	);
	return dir;
}

describe("export", () => {
	test("reads legacy transcript.md", async () => {
		const dir = await fakeRun();
		const t = await readTranscript(join(dir, "round-01", "candidates", "c1"));
		expect(t?.system).toBe("SYS");
		expect(t?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(t?.messages[0].content).toBe("CTX\n\n## Development results\nnot a turn");
	});

	test("collects one group per revision context, including single-candidate groups", async () => {
		const groups = await collectRollouts([await fakeRun()]);
		expect(groups).toHaveLength(2);
		expect(groups[0]).toMatchObject({ task: "rg:maze", round: 1, parentScore: 0.2, prompt: { system: "SYS" } });
		expect(groups[0].prompt.messages).toEqual([{ role: "user", content: "CTX" }]);
		expect(groups[0].candidates.map((c) => c.response)).toEqual(["EDIT A", "BAD AGAIN"]);
		expect(groups[1].candidates[0].advantage).toBe(0);
	});

	test("applies the App. B.2 filter", async () => {
		const groups = await collectRollouts([await fakeRun()]);
		const sft = selectSft(groups);
		expect(sft).toHaveLength(1);
		expect(sft[0].messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
		expect(sft[0].messages[2].content).toBe("EDIT A");
		expect(selectSft(groups, { minGain: 0.3 })).toHaveLength(0);
		expect(selectSft(groups, { firstRoundOnly: false, minScore: 0.4 })).toHaveLength(1);
	});

	test("writes rollouts.jsonl and sft.jsonl", async () => {
		const out = await mkdtemp(join(tmpdir(), "tta-export-out-"));
		const counts = await exportLearningData([await fakeRun()], out);
		expect(counts).toEqual({ groups: 2, candidates: 3, sft: 1 });
		const lines = (await readFile(join(out, "rollouts.jsonl"), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(2);
	});
});
