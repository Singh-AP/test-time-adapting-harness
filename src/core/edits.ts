export interface EditBlock {
	search: string;
	replace: string;
}

export type ParsedProposal =
	| { kind: "edits"; blocks: EditBlock[]; diagnosis?: string; manifest?: string }
	| { kind: "full"; source: string; diagnosis?: string; manifest?: string }
	| { kind: "no_change"; reason: string }
	| { kind: "unparseable"; error: string };

export type ApplyResult = { ok: true; source: string } | { ok: false; error: string };

const SEARCH_LINE = /^\s*<{5,9}\s*SEARCH\s*$/;
const DIVIDER_LINE = /^\s*={5,9}\s*$/;
const REPLACE_LINE = /^\s*>{5,9}\s*REPLACE\s*$/;
const NO_CHANGE = /^\s*(?:\*\*)?NO_CHANGE(?:\*\*)?\s*[:\-—]?\s*(.*)$/m;
const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const JS_LANGS = new Set(["", "js", "javascript", "mjs", "jsx"]);

/** Extracts SEARCH/REPLACE blocks. Content between markers is kept verbatim. */
export function parseEditBlocks(text: string): { blocks: EditBlock[]; error?: string } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: EditBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		if (!SEARCH_LINE.test(lines[i])) {
			i++;
			continue;
		}
		const start = i + 1;
		let divider = -1;
		let end = -1;
		for (let j = start; j < lines.length; j++) {
			if (divider < 0 && DIVIDER_LINE.test(lines[j])) {
				divider = j;
				continue;
			}
			if (divider >= 0 && REPLACE_LINE.test(lines[j])) {
				end = j;
				break;
			}
			if (SEARCH_LINE.test(lines[j])) break;
		}
		if (divider < 0 || end < 0) {
			return {
				blocks,
				error: `Edit block ${blocks.length + 1} is incomplete: expected "=======" and ">>>>>>> REPLACE" after "<<<<<<< SEARCH".`,
			};
		}
		blocks.push({
			search: lines.slice(start, divider).join("\n"),
			replace: lines.slice(divider + 1, end).join("\n"),
		});
		i = end + 1;
	}
	return { blocks };
}

/** Parses a proposer's final answer into edits, a full harness, or a no-change declaration. */
export function parseProposal(text: string): ParsedProposal {
	const normalized = text.replace(/\r\n/g, "\n");
	const diagnosis = extractSection(normalized, ["diagnosis"]);
	const manifest = extractSection(normalized, ["change manifest", "manifest"]);
	const { blocks, error } = parseEditBlocks(normalized);
	if (error) return { kind: "unparseable", error };
	if (blocks.length > 0) return { kind: "edits", blocks, diagnosis, manifest };
	const noChange = NO_CHANGE.exec(normalized);
	if (noChange) return { kind: "no_change", reason: noChange[1].trim() || "declared no change" };
	const full = findFullHarness(normalized);
	if (full) return { kind: "full", source: full, diagnosis, manifest };
	return {
		kind: "unparseable",
		error: "No edits found. Use SEARCH/REPLACE blocks (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE), a complete harness in one ```js code block, or reply NO_CHANGE: <reason>.",
	};
}

/** Applies blocks in order: exact unique match first, then a unique whitespace-insensitive line match. */
export function applyEdits(source: string, blocks: readonly EditBlock[]): ApplyResult {
	let current = source.replace(/\r\n/g, "\n");
	for (const [index, block] of blocks.entries()) {
		const label = `Edit ${index + 1}`;
		const search = block.search.replace(/\r\n/g, "\n");
		const replace = block.replace.replace(/\r\n/g, "\n");
		if (search.trim() === "") {
			current = `${current.replace(/\n*$/, "\n")}${replace}\n`;
			continue;
		}
		const occurrences = countOccurrences(current, search);
		if (occurrences === 1) {
			current = current.replace(search, () => replace);
			continue;
		}
		if (occurrences > 1) {
			return {
				ok: false,
				error: `${label}: the SEARCH text occurs ${occurrences} times in the current harness. Include more surrounding lines so it matches exactly once.`,
			};
		}
		const loose = replaceLinesLoosely(current, search, replace);
		if (loose.kind === "ok") {
			current = loose.source;
			continue;
		}
		if (loose.kind === "ambiguous") {
			return {
				ok: false,
				error: `${label}: the SEARCH text matches ${loose.count} places when whitespace is ignored. Include more surrounding lines.`,
			};
		}
		const first = search.split("\n").find((line) => line.trim().length > 0) ?? "";
		return {
			ok: false,
			error: `${label}: the SEARCH text was not found in the current harness. SEARCH must copy existing lines exactly. Its first line was ${JSON.stringify(first.trim().slice(0, 120))}.`,
		};
	}
	return { ok: true, source: current };
}

/** Body of the first markdown section whose heading starts with one of `names`. */
export function extractSection(text: string, names: readonly string[]): string | undefined {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const heading = /^#{1,6}\s+(.*)$/.exec(lines[i]);
		if (!heading) continue;
		const title = heading[1].trim().toLowerCase();
		if (!names.some((name) => title.startsWith(name))) continue;
		const body: string[] = [];
		for (let j = i + 1; j < lines.length && !/^#{1,6}\s+/.test(lines[j]); j++) body.push(lines[j]);
		const content = body.join("\n").trim();
		return content.length > 0 ? content : undefined;
	}
	return undefined;
}

function findFullHarness(text: string): string | undefined {
	let best: string | undefined;
	for (const match of text.matchAll(FENCE)) {
		const lang = match[1].trim().split(/\s+/)[0].toLowerCase();
		if (!JS_LANGS.has(lang)) continue;
		const body = match[2];
		if (!/\bfunction\s+solve\s*\(/.test(body)) continue;
		if (!best || body.length > best.length) best = body;
	}
	return best?.replace(/\s+$/, "\n");
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
	return count;
}

type LooseResult = { kind: "ok"; source: string } | { kind: "ambiguous"; count: number } | { kind: "missing" };

function replaceLinesLoosely(source: string, search: string, replace: string): LooseResult {
	const lines = source.split("\n");
	const needle = trimBlankEdges(search.split("\n"));
	if (needle.length === 0) return { kind: "missing" };
	const normalizers = [(s: string) => s.trimEnd(), (s: string) => s.trim()];
	for (const normalize of normalizers) {
		const target = needle.map(normalize);
		const hits: number[] = [];
		for (let i = 0; i + target.length <= lines.length; i++) {
			let match = true;
			for (let j = 0; j < target.length; j++) {
				if (normalize(lines[i + j]) !== target[j]) {
					match = false;
					break;
				}
			}
			if (match) hits.push(i);
		}
		if (hits.length === 1) {
			const at = hits[0];
			const out = [...lines.slice(0, at), ...replace.split("\n"), ...lines.slice(at + target.length)];
			return { kind: "ok", source: out.join("\n") };
		}
		if (hits.length > 1) return { kind: "ambiguous", count: hits.length };
	}
	return { kind: "missing" };
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
}
