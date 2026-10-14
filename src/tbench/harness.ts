import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

/** An independent reviewer that audits the container after the agent finishes (fresh context, bash and read). */
export interface ReviewSettings {
	/** Reviewer system prompt. */
	prompt: string;
	/** Reviewer's first message; `{{instruction}}`, `{{summary}}`, `{{time_left}}` are replaced. */
	request: string;
	/** Sent to the agent after a failed review; `{{issues}}`, `{{time_left}}` are replaced. */
	followup: string;
	maxRounds: number;
	/** Skip reviews when less time than this remains. */
	minTimeLeftSec: number;
}

export interface BashSettings {
	defaultTimeoutSec: number;
	maxTimeoutSec: number;
	headBytes: number;
	tailBytes: number;
}

/**
 * A terminal-agent harness: everything around the fixed model that the adaptation loop may change.
 * On disk it is a directory with harness.json plus system.md, user.md, probe.sh and finish.md.
 */
export interface Harness {
	name: string;
	systemPrompt: string;
	/** First user message; `{{instruction}}`, `{{environment}}`, `{{time_budget}}` are replaced. */
	userPrompt: string;
	/** Shell script run in the container before the first turn; its output fills `{{environment}}`. */
	probe: string;
	/** Prompt sent when the agent first stops, asking it to verify before finishing; empty disables it. */
	finishCheck: string;
	maxFinishChecks: number;
	thinkingLevel: ThinkingLevel | "off";
	bash: BashSettings;
	/** Effective context window; compaction triggers near it. */
	contextWindow: number;
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	/** Fractions of the time budget at which the agent is told how much time remains. */
	timeWarnings: number[];
	review?: ReviewSettings;
	/** Continuations after a reply cut off by the output limit (compacting first when the context is large). */
	maxLengthRecoveries: number;
	/** Sent after a truncated reply; `{{time_left}}` is replaced. */
	continuePrompt: string;
}

export const HARNESS_DEFAULTS: Omit<Harness, "name" | "systemPrompt" | "userPrompt" | "probe" | "finishCheck"> = {
	maxFinishChecks: 1,
	thinkingLevel: "high",
	bash: { defaultTimeoutSec: 600, maxTimeoutSec: 3600, headBytes: 12_000, tailBytes: 24_000 },
	contextWindow: 400_000,
	compaction: { enabled: true, reserveTokens: 32_000, keepRecentTokens: 60_000 },
	timeWarnings: [0.5, 0.75, 0.9],
	maxLengthRecoveries: 6,
	continuePrompt:
		"Your last reply was cut off by the output length limit before you acted. Continue the task from where you were: keep your reasoning brief and call the tools you need. About {{time_left}} remain.",
};

async function optionalFile(path: string): Promise<string> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch {
		return "";
	}
}

export async function loadHarness(dir: string): Promise<Harness> {
	const config = JSON.parse(await readFile(join(dir, "harness.json"), "utf8")) as Partial<Harness> & {
		review?: Partial<ReviewSettings>;
	};
	const reviewPrompt = await optionalFile(join(dir, "review.md"));
	const review: ReviewSettings | undefined = reviewPrompt
		? {
				prompt: reviewPrompt,
				request:
					(await optionalFile(join(dir, "review-request.md"))) ||
					"# Task\n{{instruction}}\n\n# The agent's final summary\n{{summary}}",
				followup:
					(await optionalFile(join(dir, "review-followup.md"))) ||
					"An independent reviewer found problems:\n\n{{issues}}\n\nVerify and fix them.",
				maxRounds: config.review?.maxRounds ?? 2,
				minTimeLeftSec: config.review?.minTimeLeftSec ?? 600,
			}
		: undefined;
	return {
		...HARNESS_DEFAULTS,
		...config,
		bash: { ...HARNESS_DEFAULTS.bash, ...(config.bash ?? {}) },
		compaction: { ...HARNESS_DEFAULTS.compaction, ...(config.compaction ?? {}) },
		name: config.name ?? dir,
		systemPrompt: await optionalFile(join(dir, "system.md")),
		userPrompt: (await optionalFile(join(dir, "user.md"))) || "{{instruction}}",
		probe: await optionalFile(join(dir, "probe.sh")),
		finishCheck: await optionalFile(join(dir, "finish.md")),
		review,
	};
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => vars[key] ?? match);
}

export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
