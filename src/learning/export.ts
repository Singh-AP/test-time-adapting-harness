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
	const system =
		systemStart >= 0 && marks.length > 0
			? markdown.slice(systemStart + "## System\n".length, marks[0].index).trim()
			: "";
	const messages: SolverMessage[] = marks.map((m, i) => {
		const start = (m.index ?? 0) + m[0].length;
		const end =
			i + 1 < marks.length
				? marks[i + 1].index
				: markdown.search(/^## Errors$/m) > start
					? markdown.search(/^## Errors$/m)
					: markdown.length;
		return { role: m[2] as "user" | "assistant", content: markdown.slice(start, end).trim() };
	});
	return { system, messages };
}

function lastAssistant(t: Transcript | undefined): string | null {
	if (!t) return null;
	for (let i = t.messages.length - 1; i >= 0; i--)
		if (t.messages[i].role === "assistant") return t.messages[i].content;
	return null;
}

/** GRPO groups from adaptation run directories. */
export async function collectRollouts(runDirs: readonly string[]): Promise<RolloutGroup[]> {
	const groups: RolloutGroup[] = [];
	for (const run of runDirs) {
		const config = await readJson<{ task?: { name?: string } }>(join(run, "config.json"));
		const task = config?.task?.name ?? "unknown";
		const rounds = (await readdir(run).catch(() => [] as string[]))
			.filter((d) => /^round-\d+$/.test(d) && d !== "round-00")
			.sort();
		for (const dir of rounds) {
			const summary = await readJson<RoundSummary>(join(run, dir, "round.json"));
			if (!summary || summary.candidates.length === 0) continue;
			const transcripts = await Promise.all(
				summary.candidates.map((c: CandidateSummary) =>
					readTranscript(join(run, dir, "candidates", `c${c.index}`)),
				),
			);
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

export async function exportLearningData(
	runDirs: readonly string[],
	outDir: string,
): Promise<{ groups: number; candidates: number; sft: number }> {
	const groups = await collectRollouts(runDirs);
	const sft = selectSft(groups);
	await mkdir(outDir, { recursive: true });
	await writeFile(
		join(outDir, "rollouts.jsonl"),
		groups.map((g) => JSON.stringify(g)).join("\n") + (groups.length ? "\n" : ""),
	);
	await writeFile(join(outDir, "sft.jsonl"), sft.map((s) => JSON.stringify(s)).join("\n") + (sft.length ? "\n" : ""));
	return { groups: groups.length, candidates: groups.reduce((n, g) => n + g.candidates.length, 0), sft: sft.length };
}
