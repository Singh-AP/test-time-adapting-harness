import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoPath } from "../../config.ts";
import type { Passage, Question, QuestionOutcome, Task } from "../../core/types.ts";
import { Bm25Index } from "../../tools/bm25.ts";
import { createRng, shuffle } from "../../util/random.ts";
import { exactMatch, f1Score } from "./grading.ts";

export type QaDataset = "hotpotqa" | "musique" | "2wiki";

export interface QaRecord {
	id: string;
	question: string;
	answer: string;
	aliases: string[];
	supporting_titles: string[];
	type: string;
}

export interface QaTaskOptions {
	name: QaDataset;
	/** Directory with corpus.jsonl and questions.jsonl (default data/qa/<name>). */
	dir?: string;
	devSize?: number;
	testSize?: number;
	seed?: number;
}

const LABELS: Record<QaDataset, string> = {
	hotpotqa: "HotpotQA",
	musique: "MuSiQue",
	"2wiki": "2WikiMultihopQA",
};

async function readJsonl<T>(path: string): Promise<T[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}

/** Disjoint dev and test samples, allocated across `type` proportionally to its share of the records. */
export function stratifiedSplit<T extends { type: string }>(
	records: readonly T[],
	devSize: number,
	testSize: number,
	rng: () => number,
): { dev: T[]; test: T[] } {
	const groups = new Map<string, T[]>();
	for (const r of records) {
		const group = groups.get(r.type) ?? [];
		group.push(r);
		groups.set(r.type, group);
	}
	const types = [...groups.keys()].sort();
	const quotas = (size: number) => {
		const out = new Map<string, number>();
		let assigned = 0;
		types.forEach((type, i) => {
			const share =
				i === types.length - 1
					? size - assigned
					: Math.round((size * (groups.get(type)?.length ?? 0)) / records.length);
			out.set(type, Math.max(0, share));
			assigned += Math.max(0, share);
		});
		return out;
	};
	const devQuota = quotas(devSize);
	const testQuota = quotas(testSize);
	const dev: T[] = [];
	const test: T[] = [];
	for (const type of types) {
		const shuffled = shuffle(groups.get(type) ?? [], rng);
		const d = devQuota.get(type) ?? 0;
		const t = testQuota.get(type) ?? 0;
		dev.push(...shuffled.slice(0, d));
		test.push(...shuffled.slice(d, d + t));
	}
	return { dev: shuffle(dev, rng), test: shuffle(test, rng) };
}

function retrievedTitles(outcome: QuestionOutcome): Set<string> {
	const titles = new Set<string>();
	for (const event of outcome.trace) {
		if (event.tool !== "search") continue;
		for (const title of event.output.split(" | ")) if (title.trim()) titles.add(title.trim());
	}
	return titles;
}

/** A multi-hop QA benchmark: pooled paragraph corpus with BM25 search and exact-match grading. */
export async function createQaTask(o: QaTaskOptions): Promise<Task> {
	const dir = o.dir ?? repoPath("data", "qa", o.name);
	const corpus = await readJsonl<Passage>(join(dir, "corpus.jsonl"));
	const records = await readJsonl<QaRecord>(join(dir, "questions.jsonl"));
	const index = new Bm25Index(corpus);
	const { dev, test } = stratifiedSplit(records, o.devSize ?? 500, o.testSize ?? 300, createRng(o.seed ?? 1));
	const toQuestion = (r: QaRecord): Question => ({
		id: r.id,
		prompt: r.question,
		answer: r.answer,
		meta: { aliases: r.aliases, supporting: r.supporting_titles, type: r.type },
	});
	const golds = (q: Question) => [q.answer, ...((q.meta?.aliases as string[] | undefined) ?? [])];
	return {
		name: `qa:${o.name}`,
		description: `${LABELS[o.name]} multi-hop question answering. Answering a question needs facts from two or more of ${index.size} Wikipedia paragraphs, which search() retrieves by BM25. The answer is a short span (an entity, date, number, or yes/no). Grading is exact match after lowercasing and removing punctuation and articles${o.name === "musique" ? "; listed answer aliases also count" : ""}.`,
		capabilities: ["llm", "search"],
		dev: dev.map(toQuestion),
		heldout: test.map(toQuestion),
		search: index,
		grade: async (question, answer) => {
			if (exactMatch(answer, golds(question))) return { score: 1 };
			const f1 = Math.max(...golds(question).map((g) => f1Score(answer, g)));
			return { score: 0, detail: `F1 ${f1.toFixed(2)}` };
		},
		describeOutcome: (question, outcome) => {
			const supporting = (question.meta?.supporting as string[] | undefined) ?? [];
			if (supporting.length === 0) return undefined;
			const titles = retrievedTitles(outcome);
			const retrieved = supporting.filter((t) => titles.has(t));
			const missed = supporting.filter((t) => !titles.has(t));
			const list = (xs: string[]) => (xs.length ? JSON.stringify(xs) : "none");
			return `Supporting documents: retrieved ${list(retrieved)}, missed ${list(missed)}.`;
		},
	};
}
