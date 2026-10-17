import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { clip, clipMiddle } from "../util/text.ts";

/** One Harbor trial of the pi harness, distilled for execution reports. */
export interface TrialSummary {
	task: string;
	trial: string;
	reward: number;
	exception?: string;
	instruction: string;
	finalText: string;
	stopReason: string;
	turns: number;
	minutes: number;
	/** The agent's wall-clock budget in minutes (0 if unknown). */
	budgetMinutes: number;
	cost: number;
	reviews: { verdict: string; issues: string }[];
	failedTests: string[];
	passedTests: number;
	testOutput: string;
	transcriptTail: string;
}

async function readJson(path: string): Promise<Record<string, any> | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function readText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * Tasks a comparison covers: the dev or held-out tasks of a split (or both, for "all"), optionally only those whose
 * reference solution passes offline (the split's "offline" list).
 */
export function comparisonTasks(
	split: { dev: string[]; heldout: string[]; offline?: string[] },
	subset: string,
	offlineOnly: boolean,
): Set<string> {
	const pool = subset === "all" ? [...split.dev, ...split.heldout] : subset === "heldout" ? split.heldout : split.dev;
	const offline = new Set(split.offline ?? pool);
	return new Set(offlineOnly ? pool.filter((t) => offline.has(t)) : pool);
}

/** Loads every trial under the given Harbor job directories, sorted by task name. */
export async function loadTrials(jobDirs: string[]): Promise<TrialSummary[]> {
	const trials: TrialSummary[] = [];
	for (const job of jobDirs) {
		for (const entry of await readdir(job, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.includes("__")) continue;
			const dir = join(job, entry.name);
			const result = await readJson(join(dir, "result.json"));
			if (!result) continue;
			const config = (await readJson(join(dir, "config.json"))) ?? {};
			const agentConfig = (await readJson(join(dir, "agent", "agent-config.json"))) ?? {};
			const agent = (await readJson(join(dir, "agent", "agent-result.json"))) ?? {};
			const ctrf = await readJson(join(dir, "verifier", "ctrf.json"));
			const tests = (ctrf?.results?.tests ?? []) as { name: string; status: string }[];
			const name = String(config.task?.name ?? entry.name.split("__")[0]);
			trials.push({
				task: name.includes("/") ? name : `terminal-bench/${name}`,
				trial: entry.name,
				reward: Number(result.verifier_result?.rewards?.reward ?? 0),
				exception: result.exception_info?.exception_type ?? undefined,
				instruction: String(agentConfig.instruction ?? ""),
				finalText: String(agent.finalText ?? ""),
				stopReason: String(agent.stopReason ?? "unknown"),
				turns: Number(agent.turns ?? 0),
				minutes: Number(agent.elapsedSec ?? 0) / 60,
				budgetMinutes: Number(agentConfig.timeBudgetSec ?? 0) / 60,
				cost: Number(agent.cost ?? 0),
				reviews: ((agent.reviews ?? []) as { verdict: string; issues: string }[]).map((r) => ({
					verdict: r.verdict,
					issues: r.issues,
				})),
				failedTests: tests.filter((t) => t.status !== "passed" && t.status !== "skipped").map((t) => t.name),
				passedTests: tests.filter((t) => t.status === "passed").length,
				testOutput: await readText(join(dir, "verifier", "test-stdout.txt")),
				transcriptTail: (await readText(join(dir, "agent", "transcript.md"))).slice(-6000),
			});
		}
	}
	return trials.sort((a, b) => a.task.localeCompare(b.task) || a.trial.localeCompare(b.trial));
}

export interface TbenchReportOptions {
	/** Only these tasks may appear (the dev split); held-out tasks never reach the proposer. */
	allowedTasks: Set<string>;
	maxFailures?: number;
	charsPerFailure?: number;
}

/** Execution report of a harness on dev tasks (paper App. E.2, adapted to terminal tasks). */
export function buildTbenchReport(all: TrialSummary[], o: TbenchReportOptions): string {
	const trials = all.filter((t) => o.allowedTasks.has(t.task));
	const solved = trials.filter((t) => t.reward >= 1);
	const failed = trials.filter((t) => t.reward < 1);
	const cost = trials.reduce((s, t) => s + t.cost, 0);
	const minutes = trials.reduce((s, t) => s + t.minutes, 0) / Math.max(1, trials.length);
	const lines = [
		`## Development results`,
		`${solved.length}/${trials.length} tasks solved (all-or-nothing hidden tests per task). Agent cost $${cost.toFixed(2)}, mean ${minutes.toFixed(0)} minutes per task.`,
		"",
		"| Task | Reward | Tests passed | Stop | Turns | Minutes | Reviews |",
		"|---|---|---|---|---|---|---|",
		...trials.map(
			(t) =>
				`| ${t.task.split("/").pop()} | ${t.reward.toFixed(0)} | ${t.passedTests}/${t.passedTests + t.failedTests.length} | ${t.exception ?? t.stopReason} | ${t.turns} | ${t.minutes.toFixed(0)} | ${t.reviews.map((r) => r.verdict).join(",")} |`,
		),
	];
	const per = o.charsPerFailure ?? 5000;
	for (const t of failed.slice(0, o.maxFailures ?? 20)) {
		lines.push(
			"",
			`### Failed: ${t.task.split("/").pop()}`,
			`Stop: ${t.exception ?? t.stopReason}; ${t.turns} turns, ${t.minutes.toFixed(0)} of ${t.budgetMinutes ? t.budgetMinutes.toFixed(0) : "?"} budget minutes used, $${t.cost.toFixed(2)}.`,
			"",
			"Task statement (excerpt):",
			"```",
			clip(t.instruction, Math.floor(per * 0.3)),
			"```",
			`Failed hidden tests: ${t.failedTests.length ? t.failedTests.join(", ") : "(none recorded)"}`,
			"Test output (excerpt):",
			"```",
			clipMiddle(t.testOutput, Math.floor(per * 0.3)),
			"```",
			"Agent's final summary:",
			clip(t.finalText || "(none)", Math.floor(per * 0.15)),
			...t.reviews.map((r, i) => `Review ${i + 1}: ${r.verdict}${r.issues ? ` - ${clip(r.issues, 600)}` : ""}`),
			"End of transcript:",
			"```",
			t.transcriptTail.slice(-Math.floor(per * 0.25)),
			"```",
		);
	}
	return `${lines.join("\n")}\n`;
}
