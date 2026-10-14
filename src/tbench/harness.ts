import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

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
}

export const HARNESS_DEFAULTS: Omit<Harness, "name" | "systemPrompt" | "userPrompt" | "probe" | "finishCheck"> = {
	maxFinishChecks: 1,
	thinkingLevel: "high",
	bash: { defaultTimeoutSec: 600, maxTimeoutSec: 3600, headBytes: 12_000, tailBytes: 24_000 },
	contextWindow: 400_000,
	compaction: { enabled: true, reserveTokens: 32_000, keepRecentTokens: 60_000 },
	timeWarnings: [0.5, 0.75, 0.9],
};

async function optionalFile(path: string): Promise<string> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch {
		return "";
	}
}

export async function loadHarness(dir: string): Promise<Harness> {
	const config = JSON.parse(await readFile(join(dir, "harness.json"), "utf8")) as Partial<Harness>;
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
