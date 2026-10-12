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
		const config = JSON.parse(await readFile(join(run, "config.json"), "utf8").catch(() => "{}")) as {
			task?: { name?: string };
		};
		const task = config.task?.name ?? "unknown";
		const rounds = (await readdir(run).catch(() => [] as string[]))
			.filter((d) => /^round-\d+$/.test(d) && d !== "round-00")
			.sort();
		for (const dir of rounds) {
			const text = await readFile(join(run, dir, "round.json"), "utf8").catch(() => undefined);
			if (!text) continue;
			const r = JSON.parse(text) as RoundFile;
			for (const c of r.candidates) {
				const status =
					c.status === "edit"
						? r.selection.chosen === c.index
							? "accepted"
							: "rejected"
						: (c.status as RevisionEpisode["status"]);
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
export async function distillPlaybook(
	client: ProposerClient,
	episodes: readonly RevisionEpisode[],
	maxWords = 400,
): Promise<string> {
	const response = await client.complete(playbookRequest(episodes, maxWords));
	if (response.stopReason === "error" || response.error)
		throw new Error(`playbook distillation failed: ${response.error ?? "unknown"}`);
	return response.text.trim();
}
