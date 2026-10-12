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
