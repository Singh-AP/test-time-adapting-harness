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
