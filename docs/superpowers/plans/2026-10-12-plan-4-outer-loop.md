# Plan 4: Outer Loop Without Weight Updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The paper's outer loop learns a revision procedure from revision outcomes on training tasks and transfers it to unseen tasks. Bedrock cannot GRPO-train our proposers, so this plan delivers (1) faithful training data for offline proposer training (GRPO groups with Eq. 8/11 rewards and group advantages; an SFT corpus with the App. B.2 filter) and (2) a non-parametric outer loop: a revision playbook distilled from training-task episodes, given to a frozen proposer on unseen tasks, with a transfer experiment.

**Architecture:** Every proposal writes `transcript.json` next to `transcript.md`. `src/learning/export.ts` turns run directories into `rollouts.jsonl` (one group per revision context) and `sft.jsonl`. `src/learning/playbook.ts` collects revision episodes (diagnosis, change, scores, accepted or not), asks a model to distill task-agnostic lessons, and the proposer prompt gains an optional "Lessons from previous adaptations" section.

**Tech Stack:** as Plans 1–3.

**Spec:** `docs/superpowers/specs/2026-10-12-test-time-adapting-harness-design.md` (§1 outer-loop substitute, increment 11)

## Global Constraints

- All Plan 1 constraints.
- Exported data never contains held-out questions: contexts are revision prompts built from feedback questions only.
- The playbook must be task-agnostic: the distillation prompt forbids task-specific answers; transfer is measured on families that contributed no episodes.

## Review Focus

1. Old runs without `transcript.json`: export falls back to parsing `transcript.md`. Pinned in Task 2 (`reads legacy transcript.md`).
2. Groups with a single candidate (G=1): exported with advantage 0, not dropped. Pinned in Task 2.
3. SFT filter boundaries: exactly `max(J(h0)+0.08, 0.40)` is kept. Pinned in Task 2 (`applies the App. B.2 filter`).
4. A playbook given to the proposer appears in the prompt once and only when configured. Pinned in Task 3.
5. Distillation input that mentions held-out text: impossible by construction (episodes come from round summaries and proposals). Pinned in Task 3 (`episodes come from proposals and round summaries only`).

---

### Task 1: transcript.json artifacts

**Files:**
- Modify: `src/core/loop.ts`, `src/core/independent.ts`, `test/loop.test.ts`

- [ ] **Step 1: Failing test** — in the first `adapt` test of `test/loop.test.ts`, add:
```ts
		const transcript = JSON.parse(await readFile(join(runDir, "round-01", "candidates", "c0", "transcript.json"), "utf8"));
		expect(transcript.system).toContain("harness engineer");
		expect(transcript.messages[0].role).toBe("user");
		expect(transcript.messages[1].content).toContain("<<<<<<< SEARCH");
```
- [ ] **Step 2: Run** `npx vitest run test/loop.test.ts` — Expected: FAIL (ENOENT transcript.json).
- [ ] **Step 3: Implement** — next to each `transcript.md` write in `loop.ts` and `independent.ts`:
```ts
await store.writeJson(`${cdir}/transcript.json`, { system: proposal.system, messages: proposal.transcript });
```
(`${dir}/transcript.json` in `independent.ts`).
- [ ] **Step 4: Run** `npm test && npm run check` — Expected: pass.
- [ ] **Step 5: Commit** `git commit -m "feat: write proposer transcripts as JSON"` and push.

---

### Task 2: Rollout and SFT export

**Files:**
- Create: `src/learning/export.ts`
- Modify: `src/cli.ts` (`tta export --out <dir> <run-dir>...`)
- Test: `test/export.test.ts`

**Interfaces:**
- Produces: `RolloutGroup`, `SftExample`, `readTranscript(candidateDir)`, `collectRollouts(runDirs): Promise<RolloutGroup[]>`, `selectSft(groups, {minGain?, minScore?, firstRoundOnly?}): SftExample[]`, `exportLearningData(runDirs, outDir): Promise<{groups, candidates, sft}>`.

- [ ] **Step 1: Write the failing test**

**Test: `test/export.test.ts`**
```ts
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
				{ index: 0, status: "edit", score: 0.48, completedFraction: 1, reward: 0.78, advantage: 1, attempts: 1, summary: "" },
				{ index: 1, status: "invalid", score: null, completedFraction: 0, reward: 0.05, advantage: -1, attempts: 3, summary: "" },
			]),
		),
	);
	await writeFile(
		join(dir, "round-01", "candidates", "c0", "transcript.json"),
		JSON.stringify({ system: "SYS", messages: [{ role: "user", content: "CTX" }, { role: "assistant", content: "EDIT A" }] }),
	);
	await writeFile(
		join(dir, "round-01", "candidates", "c1", "transcript.md"),
		"# Proposal: invalid after 2 attempt(s)\n\n## System\nSYS\n\n## 1. user\nCTX\n\n## Development results\nnot a turn\n\n## 2. assistant\nBAD\n\n## 3. user\nretry\n\n## 4. assistant\nBAD AGAIN",
	);
	await mkdir(join(dir, "round-02", "candidates", "c0"), { recursive: true });
	await writeFile(
		join(dir, "round-02", "round.json"),
		JSON.stringify(round(2, 0.48, [{ index: 0, status: "edit", score: 0.5, completedFraction: 1, reward: 0.8, advantage: 0, attempts: 1, summary: "" }])),
	);
	await writeFile(
		join(dir, "round-02", "candidates", "c0", "transcript.json"),
		JSON.stringify({ system: "SYS", messages: [{ role: "user", content: "CTX2" }, { role: "assistant", content: "EDIT B" }] }),
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
```

- [ ] **Step 2: Run** `npx vitest run test/export.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**File: `src/learning/export.ts`**
```ts
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandidateSummary, RoundSummary } from "../core/loop.ts";
import type { ProposalStatus } from "../core/proposer.ts";
import type { SolverMessage } from "../core/types.ts";

export interface Transcript {
	system: string;
	messages: SolverMessage[];
}

export interface RolloutCandidate {
	index: number;
	status: ProposalStatus;
	/** Final proposer response (the attempt that produced the candidate), or null when absent. */
	response: string | null;
	score: number | null;
	reward: number;
	advantage: number;
}

/** One revision context x_t with its G sampled responses: a GRPO group. */
export interface RolloutGroup {
	task: string;
	run: string;
	round: number;
	parentHash: string;
	parentScore: number;
	prompt: Transcript;
	candidates: RolloutCandidate[];
}

export interface SftExample {
	task: string;
	run: string;
	round: number;
	score: number;
	parentScore: number;
	messages: { role: "system" | "user" | "assistant"; content: string }[];
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Reads transcript.json, or parses the transcript.md rendering of older runs. */
export async function readTranscript(candidateDir: string): Promise<Transcript | undefined> {
	const json = await readJson<Transcript>(join(candidateDir, "transcript.json"));
	if (json) return json;
	let markdown: string;
	try {
		markdown = await readFile(join(candidateDir, "transcript.md"), "utf8");
	} catch {
		return undefined;
	}
	const turn = /^## (\d+)\. (user|assistant)$/gm;
	const marks = [...markdown.matchAll(turn)];
	const systemStart = markdown.indexOf("## System\n");
	const system = systemStart >= 0 && marks.length > 0 ? markdown.slice(systemStart + "## System\n".length, marks[0].index).trim() : "";
	const messages: SolverMessage[] = marks.map((m, i) => {
		const start = (m.index ?? 0) + m[0].length;
		const end = i + 1 < marks.length ? marks[i + 1].index : markdown.search(/^## Errors$/m) > start ? markdown.search(/^## Errors$/m) : markdown.length;
		return { role: m[2] as "user" | "assistant", content: markdown.slice(start, end).trim() };
	});
	return { system, messages };
}

function lastAssistant(t: Transcript | undefined): string | null {
	if (!t) return null;
	for (let i = t.messages.length - 1; i >= 0; i--) if (t.messages[i].role === "assistant") return t.messages[i].content;
	return null;
}

/** GRPO groups from adaptation run directories. */
export async function collectRollouts(runDirs: readonly string[]): Promise<RolloutGroup[]> {
	const groups: RolloutGroup[] = [];
	for (const run of runDirs) {
		const config = await readJson<{ task?: { name?: string } }>(join(run, "config.json"));
		const task = config?.task?.name ?? "unknown";
		const rounds = (await readdir(run).catch(() => [] as string[])).filter((d) => /^round-\d+$/.test(d) && d !== "round-00").sort();
		for (const dir of rounds) {
			const summary = await readJson<RoundSummary>(join(run, dir, "round.json"));
			if (!summary || summary.candidates.length === 0) continue;
			const transcripts = await Promise.all(summary.candidates.map((c: CandidateSummary) => readTranscript(join(run, dir, "candidates", `c${c.index}`))));
			const first = transcripts.find((t) => t !== undefined);
			if (!first) continue;
			groups.push({
				task,
				run,
				round: summary.round,
				parentHash: summary.parentHash,
				parentScore: summary.scoring.parentScore,
				prompt: { system: first.system, messages: first.messages.slice(0, 1) },
				candidates: summary.candidates.map((c, i) => ({
					index: c.index,
					status: c.status,
					response: lastAssistant(transcripts[i]),
					score: c.score,
					reward: c.reward,
					advantage: c.advantage,
				})),
			});
		}
	}
	return groups;
}

/**
 * SFT corpus (paper App. B.2): keep revisions with J(h') >= max(J(h0) + minGain, minScore).
 * The paper uses first-round teacher revisions of the seed; h0 is the round's parent.
 */
export function selectSft(
	groups: readonly RolloutGroup[],
	o: { minGain?: number; minScore?: number; firstRoundOnly?: boolean } = {},
): SftExample[] {
	const minGain = o.minGain ?? 0.08;
	const minScore = o.minScore ?? 0.4;
	const out: SftExample[] = [];
	for (const g of groups) {
		if ((o.firstRoundOnly ?? true) && g.round !== 1) continue;
		const threshold = Math.max(g.parentScore + minGain, minScore);
		for (const c of g.candidates) {
			if (c.status !== "edit" || c.score === null || c.response === null || c.score < threshold - 1e-12) continue;
			out.push({
				task: g.task,
				run: g.run,
				round: g.round,
				score: c.score,
				parentScore: g.parentScore,
				messages: [
					{ role: "system", content: g.prompt.system },
					{ role: "user", content: g.prompt.messages[0]?.content ?? "" },
					{ role: "assistant", content: c.response },
				],
			});
		}
	}
	return out;
}

export async function exportLearningData(runDirs: readonly string[], outDir: string): Promise<{ groups: number; candidates: number; sft: number }> {
	const groups = await collectRollouts(runDirs);
	const sft = selectSft(groups);
	await mkdir(outDir, { recursive: true });
	await writeFile(join(outDir, "rollouts.jsonl"), groups.map((g) => JSON.stringify(g)).join("\n") + (groups.length ? "\n" : ""));
	await writeFile(join(outDir, "sft.jsonl"), sft.map((s) => JSON.stringify(s)).join("\n") + (sft.length ? "\n" : ""));
	return { groups: groups.length, candidates: groups.reduce((n, g) => n + g.candidates.length, 0), sft: sft.length };
}
```

In `src/cli.ts`, handle `export` before task creation:
```ts
	if (command === "export") {
		const out = values.out ?? repoPath("data", "learning");
		const counts = await exportLearningData(positionals.slice(1), out);
		process.stdout.write(`${counts.groups} groups, ${counts.candidates} candidates, ${counts.sft} SFT examples -> ${out}\n`);
		return;
	}
```
with an `out: { type: "string" }` option and a help line `tta export --out <dir> <run-dir>...`.

- [ ] **Step 4: Run** `npx vitest run test/export.test.ts && npm test && npm run check` — Expected: pass. Then `node src/cli.ts export --out data/learning runs/rg-v1-rg-*` — Expected: counts printed.
- [ ] **Step 5: Commit** `git commit -m "feat: export GRPO rollout groups and an SFT corpus from runs"` and push.

---

### Task 3: Revision playbook (non-parametric outer loop)

**Files:**
- Create: `src/learning/playbook.ts`
- Modify: `src/core/prompts.ts` (`revisionPrompt` gets `playbook?`), `src/core/proposer.ts` (`ProposeOptions.playbook?`), `src/core/loop.ts` + `src/core/independent.ts` (`AdaptConfig.playbook?` / `IndependentConfig.playbook?` passed through), `src/proposers/agentic.ts` (writes `PLAYBOOK.md` and mentions it), `src/cli.ts` (`--playbook <file>`, `tta playbook --out <file> <run-dir>...`)
- Test: `test/playbook.test.ts`

**Interfaces:**
- Produces: `RevisionEpisode {task, round, status, parentScore, score, delta, summary}`, `collectEpisodes(runDirs)`, `playbookRequest(episodes, maxWords?)`, `distillPlaybook(client, episodes, maxWords?)`.

- [ ] **Step 1: Write the failing test**

**Test: `test/playbook.test.ts`**
```ts
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
			{ task: "rg:maze", round: 1, status: "accepted", parentScore: 0.2, score: 0.9, delta: 0.7, summary: "Parse the grid and run BFS" },
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
```

- [ ] **Step 2: Run** `npx vitest run test/playbook.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the implementation**

**File: `src/learning/playbook.ts`**
```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProposerClient, ProposerRequest } from "../core/types.ts";
import { clip } from "../util/text.ts";

/** One revision outcome on a training task. */
export interface RevisionEpisode {
	task: string;
	round: number;
	status: "accepted" | "rejected" | "invalid" | "no_change";
	parentScore: number;
	score: number | null;
	delta: number | null;
	summary: string;
}

interface RoundFile {
	round: number;
	scoring: { parentScore: number };
	candidates: { index: number; status: string; score: number | null; summary: string; reason?: string }[];
	selection: { chosen: number | null };
}

export async function collectEpisodes(runDirs: readonly string[]): Promise<RevisionEpisode[]> {
	const episodes: RevisionEpisode[] = [];
	for (const run of runDirs) {
		const config = JSON.parse(await readFile(join(run, "config.json"), "utf8").catch(() => "{}")) as { task?: { name?: string } };
		const task = config.task?.name ?? "unknown";
		const rounds = (await readdir(run).catch(() => [] as string[])).filter((d) => /^round-\d+$/.test(d) && d !== "round-00").sort();
		for (const dir of rounds) {
			const text = await readFile(join(run, dir, "round.json"), "utf8").catch(() => undefined);
			if (!text) continue;
			const r = JSON.parse(text) as RoundFile;
			for (const c of r.candidates) {
				const status = c.status === "edit" ? (r.selection.chosen === c.index ? "accepted" : "rejected") : (c.status as RevisionEpisode["status"]);
				episodes.push({
					task,
					round: r.round,
					status,
					parentScore: r.scoring.parentScore,
					score: c.score,
					delta: c.score === null ? null : Number((c.score - r.scoring.parentScore).toFixed(4)),
					summary: clip((c.summary || c.reason || "").replace(/\s+/g, " ").trim(), 600),
				});
			}
		}
	}
	return episodes;
}

export function playbookRequest(episodes: readonly RevisionEpisode[], maxWords = 400): ProposerRequest {
	const lines = episodes.map(
		(e) =>
			`- ${e.task} round ${e.round}: ${e.status}, development score ${e.parentScore.toFixed(3)} -> ${e.score === null ? "invalid" : e.score.toFixed(3)}. Change: ${e.summary}`,
	);
	return {
		system:
			"You write playbooks for harness engineers. A harness is a JavaScript program that organizes calls to a fixed solver model, tool use, and direct computation to answer the questions of one task. Write task-agnostic lessons only: never include answers, solutions, or details that only apply to one task.",
		messages: [
			{
				role: "user",
				content: `Below are revision episodes from adapting harnesses on several tasks: what each revision changed, its development score before and after, and whether it was kept.\n\n${lines.join("\n")}\n\nWrite a playbook of at most ${maxWords} words with general lessons for revising a harness on a new, unseen task: which kinds of changes raised scores, which failed and why, how to read an execution report to pick the next change, and pitfalls to avoid. Use short bullet points.`,
			},
		],
	};
}

/** Distills revision episodes into a task-agnostic playbook with one model call. */
export async function distillPlaybook(client: ProposerClient, episodes: readonly RevisionEpisode[], maxWords = 400): Promise<string> {
	const response = await client.complete(playbookRequest(episodes, maxWords));
	if (response.stopReason === "error" || response.error) throw new Error(`playbook distillation failed: ${response.error ?? "unknown"}`);
	return response.text.trim();
}
```

In `src/core/prompts.ts`, `revisionPrompt` takes `playbook?: string` and, when set, inserts before the branch section:
```ts
	if (o.playbook) parts.push(`# Lessons from previous adaptations (other tasks)\n${o.playbook.trim()}`);
```
Pass `playbook` from `ProposeOptions` (new optional field) in `propose()`; `AdaptConfig.playbook?: string` and `IndependentConfig.playbook?: string` are forwarded by the loop and the single-step runner; the agentic proposer writes `PLAYBOOK.md` when set and its system prompt lists it. CLI: `--playbook <file>` reads the file into the config; `tta playbook --out <file> <run-dir>...` collects episodes and distills with the proposer model.

- [ ] **Step 4: Run** `npx vitest run test/playbook.test.ts && npm test && npm run check` — Expected: pass.
- [ ] **Step 5: Commit** `git commit -m "feat: revision playbook distilled from training runs, injected into proposers"` and push.

---

### Task 4: Transfer experiment

**Files:**
- Create: `results/playbook.md`, `results/transfer.md`

- [ ] **Step 1: Distill** from the Opus and Haiku Reasoning Gym runs (training families):
```bash
node src/cli.ts playbook --out results/playbook.md runs/rg-v1-rg-* runs/rg-haiku-single-rg-*
```
- [ ] **Step 2: Run** a weak proposer on unseen families with and without the playbook (same seeds and sets):
```bash
F=arc_1d,family_relationships,emoji_mystery,n_queens,polynomial_multiplication,propositional_logic,mahjong_puzzle,shortest_path
node experiments/rg-suite.ts --families $F --proposer qwen.qwen3-32b-v1:0 --rounds 3 --tag transfer-none --out results/transfer-none.md
node experiments/rg-suite.ts --families $F --proposer qwen.qwen3-32b-v1:0 --rounds 3 --playbook results/playbook.md --tag transfer-playbook --out results/transfer-playbook.md
```
(`experiments/rg-suite.ts` gains `--playbook <file>`.)
- [ ] **Step 3: Summarize** both tables in `results/transfer.md` (mean held-out by round, per-family deltas) and commit with `git commit -m "feat: playbook transfer results"`; push.
