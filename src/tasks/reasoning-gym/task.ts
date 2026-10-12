import type { CapabilityName, Question, Task } from "../../core/types.ts";
import type { ReasoningGymBridge, RgEntry } from "./bridge.ts";

export interface ReasoningGymTaskOptions {
	family: string;
	bridge: ReasoningGymBridge;
	devSize?: number;
	heldoutSize?: number;
	devSeed?: number;
	heldoutSeed?: number;
	config?: Record<string, unknown>;
	capabilities?: CapabilityName[];
}

/** One Reasoning Gym family as a task: disjoint dev and held-out questions from different generator seeds. */
export async function createReasoningGymTask(o: ReasoningGymTaskOptions): Promise<Task> {
	const devSize = o.devSize ?? 25;
	const heldoutSize = o.heldoutSize ?? 75;
	const devSeed = o.devSeed ?? 1001;
	const heldoutSeed = o.heldoutSeed ?? 2002;
	const config = o.config ?? {};
	const dev = await o.bridge.generate(o.family, devSize, devSeed, config);
	const poolSize = heldoutSize * 2 + 10;
	const pool = await o.bridge.generate(o.family, poolSize, heldoutSeed, config);
	const seen = new Set(dev.entries.map((e) => e.question));
	const heldoutEntries: RgEntry[] = [];
	for (const entry of pool.entries) {
		if (heldoutEntries.length >= heldoutSize) break;
		if (seen.has(entry.question)) continue;
		seen.add(entry.question);
		heldoutEntries.push(entry);
	}
	const toQuestion =
		(split: "dev" | "heldout", seed: number, size: number) =>
		(entry: RgEntry): Question => ({
			id: `${o.family}/${split}/${entry.index}`,
			prompt: entry.question,
			answer: entry.answer,
			meta: { seed, size, index: entry.index },
		});
	return {
		name: `rg:${o.family}`,
		description: describeFamily(o.family, dev.doc, config),
		capabilities: o.capabilities ?? ["llm", "python"],
		dev: dev.entries.map(toQuestion("dev", devSeed, devSize)),
		heldout: heldoutEntries.map(toQuestion("heldout", heldoutSeed, poolSize)),
		grade: async (question, answer) => {
			const meta = question.meta as { seed: number; size: number; index: number };
			return { score: await o.bridge.score(o.family, meta.size, meta.seed, meta.index, answer, config) };
		},
	};
}

export function describeFamily(family: string, doc: string, config: Record<string, unknown>): string {
	const summary = doc
		.split(/\n\s*\n/)[0]
		.replace(/\s+/g, " ")
		.trim();
	const configText =
		Object.keys(config).length > 0
			? ` Generator configuration: ${JSON.stringify(config)}.`
			: " Default generator configuration.";
	return `Reasoning Gym task family "${family}".${summary ? ` ${summary}` : ""}${configText} Each question states its required answer format; solve() must return only the final answer string. Answers are scored by the family's verifier in [0, 1]; some families give partial credit.`;
}
