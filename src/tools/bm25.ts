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
