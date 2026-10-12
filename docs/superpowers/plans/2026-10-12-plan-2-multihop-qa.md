# Plan 2: Multi-hop QA Tasks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-hop QA tasks (HotpotQA, MuSiQue, 2WikiMultihopQA) with BM25 retrieval, the paper's two-hop retrieve-and-summarize seed (Fig. 12a), and end-to-end best-of-G adaptation runs on Bedrock.

**Architecture:** A one-time Python script converts the Hugging Face parquet dev splits into a pooled paragraph corpus and a question file per benchmark. A TypeScript BM25 index serves `search()`. A QA task splits questions into disjoint development and held-out sets stratified by question type, grades by normalized exact match against the answer and its aliases, and adds retrieved-versus-missed supporting documents to each report example.

**Tech Stack:** as Plan 1; `pyarrow` 21.0.0 in `.venv` for data preparation only.

**Spec:** `docs/superpowers/specs/2026-10-12-test-time-adapting-harness-design.md` (D7)

## Global Constraints

- All Plan 1 constraints.
- Downloaded parquet files are untrusted data: each lives in its own directory under `data/raw/<name>/`, is read only by `python/prepare_qa.py` run with `python -I`, and paths are passed as arguments.
- `data/` stays git-ignored; tests use a small committed fixture under `test/fixtures/qa-mini/`.
- Grading follows the official SQuAD normalization (lowercase, strip ASCII punctuation, drop articles, collapse whitespace); a prediction is correct if it matches the answer or any listed alias.

## Review Focus

1. Answers with surrounding text ("The answer is Paris.") or different casing/punctuation: normalization decides; F1 appears in the grader detail so reports explain near misses. Pinned in Task 2 (`normalizes like SQuAD`).
2. Queries that are empty, punctuation-only, or made only of stopwords: `search()` returns an empty list, not an error. Pinned in Task 1 (`handles empty queries`).
3. Duplicate paragraphs across questions: the corpus is deduplicated by (title, text). Pinned in Task 2 (`deduplicates the corpus`).
4. Held-out questions overlapping development questions: impossible by construction (disjoint split). Pinned in Task 2 (`splits disjointly and stratified`).
5. A seed that over-runs budgets on long questions: the seed uses 4 solver calls and 2 searches, under the 12/12 budgets. Pinned in Task 3.

---

### Task 1: BM25 index

**Files:**
- Create: `src/tools/bm25.ts`
- Test: `test/bm25.test.ts`

**Interfaces:**
- Consumes: `Passage`, `SearchBackend` (Plan 1 Task 3).
- Produces: `tokenize(text): string[]`, `Bm25Index` (`constructor(passages, {k1?, b?})`, `size`, `search(query, k): Promise<Passage[]>`).

- [ ] **Step 1: Write the failing test**

**Test: `test/bm25.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import { Bm25Index, tokenize } from "../src/tools/bm25.ts";

const passages = [
	{ id: "p0", title: "Paris", text: "Paris is the capital and largest city of France." },
	{ id: "p1", title: "Lyon", text: "Lyon is a city in France, known for its cuisine." },
	{ id: "p2", title: "Berlin", text: "Berlin is the capital of Germany." },
	{ id: "p3", title: "Zoë Saldaña", text: "Zoë Saldaña is an American actress." },
];

describe("tokenize", () => {
	test("lowercases, strips accents and stopwords", () => {
		expect(tokenize("The Capital of FRANCE!")).toEqual(["capital", "france"]);
		expect(tokenize("Zoë")).toEqual(["zoe"]);
	});
});

describe("Bm25Index", () => {
	const index = new Bm25Index(passages);

	test("ranks the most relevant passage first", async () => {
		const hits = await index.search("capital of France", 2);
		expect(hits.map((p) => p.id)).toEqual(["p0", "p2"]);
	});

	test("matches title terms and accent-folded queries", async () => {
		expect((await index.search("saldana actress", 1))[0].id).toBe("p3");
	});

	test("handles empty queries", async () => {
		expect(await index.search("", 3)).toEqual([]);
		expect(await index.search("the of !!", 3)).toEqual([]);
	});

	test("limits results to k and to matching documents", async () => {
		expect(await index.search("city", 10)).toHaveLength(2);
		expect(index.size).toBe(4);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bm25.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**File: `src/tools/bm25.ts`**
```ts
import type { Passage, SearchBackend } from "../core/types.ts";

const STOPWORDS = new Set(
	"a an and are as at be but by for from has have he her his i if in into is it its of on or she such that the their then there these they this to was were will with what which who whom whose when where why how did does do".split(
		" ",
	),
);

/** Lowercase, accent-folded alphanumeric tokens without English stopwords. */
export function tokenize(text: string): string[] {
	return text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

interface Postings {
	docs: Int32Array;
	tfs: Float32Array;
}

/** In-memory Okapi BM25 over title and text. */
export class Bm25Index implements SearchBackend {
	private readonly passages: readonly Passage[];
	private readonly postings = new Map<string, Postings>();
	private readonly lengths: Float32Array;
	private readonly averageLength: number;
	private readonly k1: number;
	private readonly b: number;

	constructor(passages: readonly Passage[], options: { k1?: number; b?: number } = {}) {
		this.passages = passages;
		this.k1 = options.k1 ?? 0.9;
		this.b = options.b ?? 0.4;
		this.lengths = new Float32Array(passages.length);
		const lists = new Map<string, { docs: number[]; tfs: number[] }>();
		let total = 0;
		passages.forEach((passage, doc) => {
			const tokens = tokenize(`${passage.title} ${passage.text}`);
			this.lengths[doc] = tokens.length;
			total += tokens.length;
			const counts = new Map<string, number>();
			for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
			for (const [token, tf] of counts) {
				let list = lists.get(token);
				if (!list) {
					list = { docs: [], tfs: [] };
					lists.set(token, list);
				}
				list.docs.push(doc);
				list.tfs.push(tf);
			}
		});
		for (const [token, list] of lists) {
			this.postings.set(token, { docs: Int32Array.from(list.docs), tfs: Float32Array.from(list.tfs) });
		}
		this.averageLength = passages.length > 0 ? total / passages.length : 0;
	}

	get size(): number {
		return this.passages.length;
	}

	async search(query: string, k: number): Promise<Passage[]> {
		const terms = [...new Set(tokenize(query))];
		if (terms.length === 0 || k <= 0) return [];
		const scores = new Map<number, number>();
		const n = this.passages.length;
		for (const term of terms) {
			const postings = this.postings.get(term);
			if (!postings) continue;
			const df = postings.docs.length;
			const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
			for (let i = 0; i < df; i++) {
				const doc = postings.docs[i];
				const tf = postings.tfs[i];
				const norm = this.k1 * (1 - this.b + (this.b * this.lengths[doc]) / (this.averageLength || 1));
				scores.set(doc, (scores.get(doc) ?? 0) + (idf * tf * (this.k1 + 1)) / (tf + norm));
			}
		}
		return [...scores.entries()]
			.sort((a, b) => b[1] - a[1] || a[0] - b[0])
			.slice(0, k)
			.map(([doc]) => this.passages[doc]);
	}
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/bm25.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/bm25.ts test/bm25.test.ts
git commit -m "feat: in-memory BM25 retrieval"
git push origin main
```

---

### Task 2: QA data preparation, grading and tasks

**Files:**
- Create: `python/prepare_qa.py`, `src/tasks/qa/grading.ts`, `src/tasks/qa/task.ts`, `test/fixtures/qa-mini/corpus.jsonl`, `test/fixtures/qa-mini/questions.jsonl`
- Modify: `src/tasks/registry.ts` (add `qa:<name>`)
- Test: `test/qa.test.ts`

**Interfaces:**
- Consumes: `Bm25Index` (Task 1), `Task`, `Question`, `QuestionOutcome` (Plan 1), `createRng`, `shuffle`, `repoPath`.
- Produces: `normalizeAnswer(s)`, `exactMatch(prediction, golds)`, `f1Score(prediction, gold)`; `QaRecord`, `createQaTask({name, dir?, devSize?, testSize?, seed?}): Promise<Task>`, `stratifiedSplit(records, devSize, testSize, rng)`; data files `data/qa/<name>/{corpus,questions}.jsonl`.

- [ ] **Step 1: Write the fixture and the failing test**

**Test: `test/fixtures/qa-mini/corpus.jsonl`**
```
{"id": "p0", "title": "Ed Wood", "text": "Edward Davis Wood Jr. was an American filmmaker, actor, and writer."}
{"id": "p1", "title": "Scott Derrickson", "text": "Scott Derrickson is an American director, screenwriter and producer."}
{"id": "p2", "title": "Doctor Strange (2016 film)", "text": "Doctor Strange is a 2016 American superhero film directed by Scott Derrickson."}
{"id": "p3", "title": "Paris", "text": "Paris is the capital of France."}
{"id": "p4", "title": "Eiffel Tower", "text": "The Eiffel Tower is a wrought-iron lattice tower in Paris, completed in 1889."}
{"id": "p5", "title": "Gustave Eiffel", "text": "Gustave Eiffel was a French civil engineer whose company built the Eiffel Tower."}
```

**Test: `test/fixtures/qa-mini/questions.jsonl`**
```
{"id": "q0", "question": "Were Scott Derrickson and Ed Wood of the same nationality?", "answer": "yes", "aliases": [], "supporting_titles": ["Scott Derrickson", "Ed Wood"], "type": "comparison"}
{"id": "q1", "question": "Who directed the 2016 film Doctor Strange?", "answer": "Scott Derrickson", "aliases": ["Derrickson"], "supporting_titles": ["Doctor Strange (2016 film)"], "type": "bridge"}
{"id": "q2", "question": "In what year was the tower in the capital of France completed?", "answer": "1889", "aliases": [], "supporting_titles": ["Paris", "Eiffel Tower"], "type": "bridge"}
{"id": "q3", "question": "What nationality was the engineer whose company built the Eiffel Tower?", "answer": "French", "aliases": [], "supporting_titles": ["Eiffel Tower", "Gustave Eiffel"], "type": "bridge"}
{"id": "q4", "question": "Is Paris the capital of France?", "answer": "yes", "aliases": [], "supporting_titles": ["Paris"], "type": "comparison"}
{"id": "q5", "question": "What city is the Eiffel Tower in?", "answer": "Paris", "aliases": [], "supporting_titles": ["Eiffel Tower"], "type": "bridge"}
```

**Test: `test/qa.test.ts`**
```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoPath } from "../src/config.ts";
import type { QuestionOutcome } from "../src/core/types.ts";
import { exactMatch, f1Score, normalizeAnswer } from "../src/tasks/qa/grading.ts";
import { createQaTask, stratifiedSplit } from "../src/tasks/qa/task.ts";
import { createRng } from "../src/util/random.ts";

const fixture = repoPath("test", "fixtures", "qa-mini");

describe("grading", () => {
	test("normalizes like SQuAD", () => {
		expect(normalizeAnswer("The  Eiffel-Tower!")).toBe("eiffeltower");
		expect(normalizeAnswer("An apple a day")).toBe("apple day");
		expect(exactMatch("the French", ["French"])).toBe(true);
		expect(exactMatch("Derrickson.", ["Scott Derrickson", "Derrickson"])).toBe(true);
		expect(exactMatch("The answer is Paris.", ["Paris"])).toBe(false);
		expect(f1Score("The answer is Paris", "Paris")).toBeCloseTo(0.5);
	});
});

describe("stratifiedSplit", () => {
	test("splits disjointly and stratified", () => {
		const records = Array.from({ length: 40 }, (_, i) => ({ id: `q${i}`, type: i < 30 ? "a" : "b" }));
		const { dev, test } = stratifiedSplit(records, 20, 8, createRng(1));
		expect(dev).toHaveLength(20);
		expect(test).toHaveLength(8);
		expect(dev.filter((r) => r.type === "b")).toHaveLength(5);
		const ids = new Set(dev.map((r) => r.id));
		for (const r of test) expect(ids.has(r.id)).toBe(false);
	});
});

describe("createQaTask", () => {
	test("loads a corpus, searches it, grades with aliases and describes supporting documents", async () => {
		const task = await createQaTask({ name: "hotpotqa", dir: fixture, devSize: 4, testSize: 2, seed: 1 });
		expect(task.name).toBe("qa:hotpotqa");
		expect(task.capabilities).toEqual(["llm", "search"]);
		expect(task.dev).toHaveLength(4);
		expect(task.heldout).toHaveLength(2);
		const hits = await task.search?.search("Doctor Strange director", 1);
		expect(hits?.[0].title).toBe("Doctor Strange (2016 film)");
		const q1 = [...task.dev, ...task.heldout].find((q) => q.id === "q1");
		if (!q1) throw new Error("q1 missing");
		expect((await task.grade(q1, "derrickson")).score).toBe(1);
		const wrong = await task.grade(q1, "James Gunn");
		expect(wrong.score).toBe(0);
		expect(wrong.detail).toContain("F1");
		const outcome: QuestionOutcome = {
			questionId: "q1",
			answer: "x",
			score: 0,
			kind: "wrong",
			durationMs: 1,
			calls: { llm: 1, python: 0, search: 1 },
			usage: { input: 0, output: 0, cost: 0 },
			trace: [{ tool: "search", at: 0, durationMs: 1, input: "q", output: "Paris | Doctor Strange (2016 film)" }],
		};
		expect(task.describeOutcome?.(q1, outcome)).toBe('Supporting documents: retrieved ["Doctor Strange (2016 film)"], missed none.');
	});
});

const python = repoPath(".venv", "bin", "python");
describe.skipIf(!existsSync(python))("prepare_qa.py", () => {
	test("deduplicates the corpus", () => {
		const out = mkdtempSync(join(tmpdir(), "tta-qa-"));
		const src = join(out, "in.jsonl");
		const rows = [
			{ id: "a", question: "Q1?", answer: "x", type: "bridge", supporting_facts: { title: ["T1"], sent_id: [0] }, context: { title: ["T1", "T2"], sentences: [["One."], ["Two."]] } },
			{ id: "b", question: "Q2?", answer: "y", type: "comparison", supporting_facts: { title: ["T2"], sent_id: [0] }, context: { title: ["T2", "T3"], sentences: [["Two."], ["Three."]] } },
		];
		writeFileSync(src, rows.map((r) => JSON.stringify(r)).join("\n"));
		execFileSync(python, ["-I", repoPath("python", "prepare_qa.py"), "hotpotqa", src, out]);
		const corpus = readFileSync(join(out, "corpus.jsonl"), "utf8").trim().split("\n");
		expect(corpus).toHaveLength(3);
		const questions = readFileSync(join(out, "questions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(questions[1]).toMatchObject({ id: "b", answer: "y", supporting_titles: ["T2"], type: "comparison" });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qa.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**File: `python/prepare_qa.py`**
```python
"""Convert a multi-hop QA dev split to JSONL corpus and question files.

Usage: python -I prepare_qa.py <hotpotqa|musique|2wiki> <input.parquet|input.jsonl> <output_dir>

Writes <output_dir>/corpus.jsonl ({"id", "title", "text"}) with every support and distractor paragraph of the
split, deduplicated by (title, text), and <output_dir>/questions.jsonl ({"id", "question", "answer", "aliases",
"supporting_titles", "type"}).
"""

import json
import os
import re
import sys


def _rows(path):
    if path.endswith(".jsonl"):
        with open(path, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]
    import pyarrow.parquet as pq

    return pq.read_table(path).to_pylist()


def _context_paragraphs(row):
    context = row["context"]
    return [(title, " ".join(s.strip() for s in sentences)) for title, sentences in zip(context["title"], context["sentences"])]


def _convert(dataset, row):
    if dataset in ("hotpotqa", "2wiki"):
        paragraphs = _context_paragraphs(row)
        supporting = list(dict.fromkeys(row["supporting_facts"]["title"]))
        record = {"id": row["id"], "question": row["question"], "answer": row["answer"], "aliases": [], "supporting_titles": supporting, "type": row["type"]}
        return paragraphs, record
    if dataset == "musique":
        paragraphs = [(p["title"], p["paragraph_text"]) for p in row["paragraphs"]]
        supporting = list(dict.fromkeys(p["title"] for p in row["paragraphs"] if p["is_supporting"]))
        hops = re.match(r"(\d)hop", row["id"])
        record = {
            "id": row["id"],
            "question": row["question"],
            "answer": row["answer"],
            "aliases": list(row.get("answer_aliases") or []),
            "supporting_titles": supporting,
            "type": f"{hops.group(1)}hop" if hops else "unknown",
        }
        return paragraphs, record
    raise ValueError(f"unknown dataset {dataset!r}")


def main():
    dataset, source, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)
    seen = {}
    questions = []
    for row in _rows(source):
        if dataset == "musique" and row.get("answerable") is False:
            continue
        paragraphs, record = _convert(dataset, row)
        for title, text in paragraphs:
            seen.setdefault((title, text), f"p{len(seen)}")
        questions.append(record)
    with open(os.path.join(out_dir, "corpus.jsonl"), "w", encoding="utf-8") as handle:
        for (title, text), pid in seen.items():
            handle.write(json.dumps({"id": pid, "title": title, "text": text}, ensure_ascii=False) + "\n")
    with open(os.path.join(out_dir, "questions.jsonl"), "w", encoding="utf-8") as handle:
        for record in questions:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"{dataset}: {len(questions)} questions, {len(seen)} paragraphs -> {out_dir}")


if __name__ == "__main__":
    main()
```

**File: `src/tasks/qa/grading.ts`**
```ts
const PUNCTUATION = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

/** Official SQuAD normalization: lowercase, remove punctuation, remove articles, collapse whitespace. */
export function normalizeAnswer(text: string): string {
	const lower = text.toLowerCase();
	let noPunctuation = "";
	for (const ch of lower) if (!PUNCTUATION.has(ch)) noPunctuation += ch;
	return noPunctuation
		.replace(/\b(a|an|the)\b/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 0)
		.join(" ");
}

export function exactMatch(prediction: string, golds: readonly string[]): boolean {
	const p = normalizeAnswer(prediction);
	return golds.some((g) => normalizeAnswer(g) === p);
}

/** Token-level F1 after normalization. */
export function f1Score(prediction: string, gold: string): number {
	const p = normalizeAnswer(prediction).split(" ").filter(Boolean);
	const g = normalizeAnswer(gold).split(" ").filter(Boolean);
	if (p.length === 0 || g.length === 0) return p.length === g.length ? 1 : 0;
	const counts = new Map<string, number>();
	for (const t of g) counts.set(t, (counts.get(t) ?? 0) + 1);
	let common = 0;
	for (const t of p) {
		const c = counts.get(t) ?? 0;
		if (c > 0) {
			common++;
			counts.set(t, c - 1);
		}
	}
	if (common === 0) return 0;
	const precision = common / p.length;
	const recall = common / g.length;
	return (2 * precision * recall) / (precision + recall);
}
```

**File: `src/tasks/qa/task.ts`**
```ts
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
			const share = i === types.length - 1 ? size - assigned : Math.round((size * (groups.get(type)?.length ?? 0)) / records.length);
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
	const golds = (q: Question) => [q.answer, ...(((q.meta?.aliases as string[] | undefined) ?? []))];
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
```

**File: `src/tasks/registry.ts`** — add before the final `throw`:
```ts
	if (kind === "qa" && (name === "hotpotqa" || name === "musique" || name === "2wiki")) {
		return createQaTask({ name, devSize: o.devSize, testSize: o.heldoutSize, seed: o.devSeed });
	}
```
and import `createQaTask` from `./qa/task.ts`; update the error message to list `qa:hotpotqa|musique|2wiki`.

- [ ] **Step 4: Run tests, then prepare the real data**

Run: `npx vitest run test/qa.test.ts && npm run check`
Expected: all pass.

Run:
```bash
for d in hotpotqa musique 2wiki; do .venv/bin/python -I python/prepare_qa.py $d data/raw/$d/validation.parquet data/qa/$d; done
```
Expected: three summary lines (HotpotQA about 7.4k questions, MuSiQue about 2.4k, 2Wiki about 12.6k).

- [ ] **Step 5: Commit**

```bash
git add python/prepare_qa.py src/tasks/qa src/tasks/registry.ts test/fixtures/qa-mini test/qa.test.ts
git commit -m "feat: multi-hop QA tasks with pooled corpora, BM25, exact-match grading"
git push origin main
```

---

### Task 3: QA seed harness

**Files:**
- Create: `seeds/qa-seed.js`
- Test: `test/qa-seed.test.ts`

**Interfaces:**
- Consumes: `runHarness` (Plan 1), `createQaTask` (Task 2), stub helpers.
- Produces: `seeds/qa-seed.js` (Fig. 12a: search question, summarize, write next query, search, summarize, answer from summaries).

- [ ] **Step 1: Write the failing test**

**Test: `test/qa-seed.test.ts`**
```ts
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { runHarness } from "../src/core/sandbox.ts";
import { screenHarness } from "../src/core/screens.ts";
import { createQaTask } from "../src/tasks/qa/task.ts";
import { stubSolver } from "./helpers.ts";

describe("qa seed", () => {
	test("passes screens and runs two hops within budget", async () => {
		const source = await readFile(repoPath("seeds", "qa-seed.js"), "utf8");
		expect(await screenHarness(source, { maxLines: 200 })).toEqual({ ok: true });
		const task = await createQaTask({ name: "hotpotqa", dir: repoPath("test", "fixtures", "qa-mini"), devSize: 4, testSize: 2 });
		const solver = stubSolver((r) => {
			const last = r.messages[r.messages.length - 1].content;
			if (last.includes("search query")) return "Eiffel Tower completed";
			if (last.includes("Answer the question")) return "Answer: 1889";
			return "The Eiffel Tower is in Paris and was completed in 1889.";
		});
		const run = await runHarness({
			source,
			prompt: "In what year was the tower in the capital of France completed?",
			task,
			capabilities: task.capabilities,
			deps: { solver, search: task.search },
			budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 },
		});
		expect(run.answer).toBe("1889");
		expect(run.calls).toEqual({ llm: 4, python: 0, search: 2 });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qa-seed.test.ts`
Expected: FAIL, seed file not found.

- [ ] **Step 3: Write the seed**

**File: `seeds/qa-seed.js`**
```js
// Seed QA harness (paper Fig. 12a): two-hop retrieve-and-summarize.
const K = 5;
const SUMMARIZE = "You extract facts from passages. Be concise and factual.";
const ANSWER = "You answer multi-hop questions from given facts.";

function formatPassages(passages) {
	return passages.map((p, i) => `[${i + 1}] ${p.title}: ${p.text}`).join("\n");
}

async function summarize(question, passages) {
	return await llm({
		system: SUMMARIZE,
		prompt: `Question: ${question}\n\nPassages:\n${formatPassages(passages)}\n\nSummarize the facts in these passages that help answer the question.`,
		maxTokens: 400,
	});
}

async function solve(question) {
	const first = await search(question, K);
	const summary1 = await summarize(question, first);
	const query = await llm({
		system: SUMMARIZE,
		prompt: `Question: ${question}\n\nKnown facts:\n${summary1}\n\nWrite one search query for the missing information needed to answer the question. Reply with the search query only.`,
		maxTokens: 60,
	});
	const second = await search(query.split("\n")[0].replace(/^["']|["']$/g, ""), K);
	const summary2 = await summarize(question, second);
	const reply = await llm({
		system: ANSWER,
		prompt: `Question: ${question}\n\nFacts:\n${summary1}\n${summary2}\n\nAnswer the question with a short span (an entity, date, number, or yes/no). Reply in the form: Answer: <answer>`,
		maxTokens: 60,
	});
	const marker = reply.toLowerCase().lastIndexOf("answer:");
	return (marker >= 0 ? reply.slice(marker + "answer:".length) : reply).trim().replace(/\.$/, "");
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/qa-seed.test.ts && npm test && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add seeds/qa-seed.js test/qa-seed.test.ts
git commit -m "feat: two-hop retrieve-and-summarize QA seed harness"
git push origin main
```

---

### Task 4: QA end-to-end runs

**Files:**
- Create: `experiments/qa-suite.ts`, `results/qa-multistep.md`

**Interfaces:**
- Consumes: `createQaTask`, `adapt`, `QA_PROTOCOL`, `evaluateHarness`, Bedrock clients.
- Produces: QA result table, including cross-benchmark held-out scores of the harness adapted on HotpotQA.

- [ ] **Step 1: Write the suite**

**File: `experiments/qa-suite.ts`**
```ts
// QA protocol (best-of-G, disjoint feedback and scoring questions) on multi-hop QA benchmarks, plus
// held-out scores of each adapted harness on the other benchmarks.
// Usage: AWS_PROFILE=... node experiments/qa-suite.ts --datasets hotpotqa,musique,2wiki --rounds 6 --proposals 4 --scoring 32 --heldout 150 --out results/qa-multistep.md
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PROPOSER_MODEL, DEFAULT_SOLVER_MODEL, repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { evaluateHarness } from "../src/core/executor.ts";
import { type AdaptSummary, adapt, QA_PROTOCOL } from "../src/core/loop.ts";
import type { Task } from "../src/core/types.ts";
import { createBedrockModels, PiProposerClient, PiSolverClient, requireModel } from "../src/llm/pi-clients.ts";
import { createQaTask, type QaDataset } from "../src/tasks/qa/task.ts";
import { Semaphore } from "../src/util/concurrency.ts";
import { fmt } from "../src/util/text.ts";

const { values } = parseArgs({
	options: {
		datasets: { type: "string" },
		solver: { type: "string" },
		proposer: { type: "string" },
		reasoning: { type: "string" },
		rounds: { type: "string" },
		proposals: { type: "string" },
		feedback: { type: "string" },
		scoring: { type: "string" },
		dev: { type: "string" },
		heldout: { type: "string" },
		tag: { type: "string" },
		out: { type: "string" },
	},
});
process.env.AWS_REGION ??= "us-east-1";
const datasets = (values.datasets ?? "hotpotqa").split(",") as QaDataset[];
const tag = values.tag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const models = createBedrockModels();
const solverId = values.solver ?? DEFAULT_SOLVER_MODEL;
const proposerId = values.proposer ?? DEFAULT_PROPOSER_MODEL;
const solver = new PiSolverClient({ models, model: requireModel(models, solverId), limiter: new Semaphore(32), temperature: 0.6 });
const proposer = new PiProposerClient({ models, model: requireModel(models, proposerId), reasoning: (values.reasoning ?? "medium") as "medium" });
const seedSource = await readFile(repoPath("seeds", "qa-seed.js"), "utf8");
const budgets = { ...DEFAULT_BUDGETS, maxTokensPerCall: 2048, questionTimeoutMs: 240_000 };
const tasks = new Map<QaDataset, Task>();
for (const name of datasets) {
	tasks.set(name, await createQaTask({ name, devSize: Number(values.dev ?? 500), testSize: Number(values.heldout ?? 150), seed: 1 }));
}

const summaries = new Map<QaDataset, AdaptSummary>();
const finals = new Map<QaDataset, string>();
for (const name of datasets) {
	const task = tasks.get(name) as Task;
	const runDir = repoPath("runs", `${tag}-qa-${name}`);
	const summary = await adapt({
		task,
		seedSource,
		config: {
			...QA_PROTOCOL,
			rounds: Number(values.rounds ?? QA_PROTOCOL.rounds),
			proposals: Number(values.proposals ?? QA_PROTOCOL.proposals),
			feedbackSize: Number(values.feedback ?? QA_PROTOCOL.feedbackSize),
			scoringSize: Number(values.scoring ?? QA_PROTOCOL.scoringSize),
			budgets,
			concurrency: 16,
			seed: 1,
		},
		deps: { solver, proposer },
		runDir,
		log: (line) => process.stderr.write(`[${name}] ${line}\n`),
	});
	summaries.set(name, summary);
	finals.set(name, await readFile(`${runDir}/final.js`, "utf8"));
}

const cross: string[] = [];
for (const [from, source] of finals) {
	const cells: string[] = [];
	for (const to of datasets) {
		if (to === from) {
			cells.push(fmt(summaries.get(from)?.finalHeldout ?? 0, 3));
			continue;
		}
		const task = tasks.get(to) as Task;
		const result = await evaluateHarness({ task, source, questions: task.heldout, label: `cross-${from}-${to}`, deps: { solver, search: task.search }, budgets, concurrency: 16 });
		cells.push(fmt(result.mean, 3));
	}
	cross.push(`| adapted on ${from} | ${cells.join(" | ")} |`);
}

const rounds = Math.max(...[...summaries.values()].map((s) => s.rounds.length));
const header = ["Benchmark", "Seed", ...Array.from({ length: rounds }, (_, i) => `R${i + 1}`), "Δ", "Proposer $", "Solver $"];
const rows = datasets.map((name) => {
	const s = summaries.get(name) as AdaptSummary;
	const perRound = s.rounds.map((r) => (r.heldout === undefined ? "–" : fmt(r.heldout, 3)));
	return `| ${name} | ${fmt(s.seedHeldout ?? 0, 3)} | ${perRound.join(" | ")} | ${fmt((s.finalHeldout ?? 0) - (s.seedHeldout ?? 0), 3)} | ${s.usage.proposer.cost.toFixed(2)} | ${s.usage.solver.cost.toFixed(2)} |`;
});
const table = [
	`# Multi-hop QA adaptation (${tag})`,
	"",
	`Solver ${solverId}, proposer ${proposerId}. QA protocol: best-of-G with G=${values.proposals ?? QA_PROTOCOL.proposals}, ${values.feedback ?? QA_PROTOCOL.feedbackSize} feedback and ${values.scoring ?? QA_PROTOCOL.scoringSize} disjoint scoring questions per round; held-out exact match after each round.`,
	"",
	`| ${header.join(" | ")} |`,
	`|${header.map(() => "---").join("|")}|`,
	...rows,
	"",
	"Held-out exact match of each final harness on every benchmark (diagonal: in-domain):",
	"",
	`| Harness | ${datasets.join(" | ")} |`,
	`|---|${datasets.map(() => "---").join("|")}|`,
	...cross,
	"",
].join("\n");
if (values.out) {
	await mkdir(dirname(values.out), { recursive: true });
	await writeFile(values.out, table);
}
process.stdout.write(table);
```

- [ ] **Step 2: Run the suite**

Run:
```bash
export AWS_PROFILE=<aws-profile>
node experiments/qa-suite.ts --datasets hotpotqa,musique,2wiki --rounds 6 --proposals 4 --scoring 32 --heldout 150 --out results/qa-multistep.md
```
Expected: per-round held-out exact match for each benchmark and a cross-benchmark table.

- [ ] **Step 3: Commit**

```bash
git add experiments/qa-suite.ts results/qa-multistep.md
git commit -m "feat: multi-hop QA adaptation results on Bedrock"
git push origin main
```
