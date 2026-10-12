import { describe, expect, test } from "vitest";
import { applyEdits, parseEditBlocks, parseProposal } from "../src/core/edits.ts";

const SOURCE = [
	'const SYSTEM = "Answer briefly.";',
	"",
	"async function solve(question) {",
	"\tconst reply = await llm({ system: SYSTEM, prompt: question });",
	"\treturn reply.trim();",
	"}",
	"",
].join("\n");

describe("parseProposal", () => {
	test("parses SEARCH/REPLACE blocks, diagnosis and manifest", () => {
		const text = [
			"## Diagnosis",
			"Answers include reasoning.",
			"## Edits",
			"```js",
			"<<<<<<< SEARCH",
			"\treturn reply.trim();",
			"=======",
			'\treturn reply.split("Answer:").pop().trim();',
			">>>>>>> REPLACE",
			"```",
			"## Change manifest",
			"Extract the final answer.",
		].join("\n");
		const parsed = parseProposal(text);
		expect(parsed.kind).toBe("edits");
		if (parsed.kind !== "edits") return;
		expect(parsed.blocks).toEqual([
			{ search: "\treturn reply.trim();", replace: '\treturn reply.split("Answer:").pop().trim();' },
		]);
		expect(parsed.diagnosis).toBe("Answers include reasoning.");
		expect(parsed.manifest).toBe("Extract the final answer.");
	});

	test("recognizes NO_CHANGE", () => {
		expect(parseProposal("NO_CHANGE: already optimal")).toEqual({ kind: "no_change", reason: "already optimal" });
	});

	test("accepts a full harness code block", () => {
		const parsed = parseProposal(
			'Here is the new harness:\n```javascript\nasync function solve(q) {\n\treturn "1";\n}\n```',
		);
		expect(parsed.kind).toBe("full");
		if (parsed.kind === "full") expect(parsed.source).toBe('async function solve(q) {\n\treturn "1";\n}\n');
	});

	test("reports incomplete blocks and missing edits", () => {
		expect(parseProposal("<<<<<<< SEARCH\nfoo\n=======\nbar").kind).toBe("unparseable");
		expect(parseProposal("I would change the prompt.").kind).toBe("unparseable");
	});

	test("handles CRLF responses", () => {
		const { blocks } = parseEditBlocks("<<<<<<< SEARCH\r\na\r\n=======\r\nb\r\n>>>>>>> REPLACE\r\n");
		expect(blocks).toEqual([{ search: "a", replace: "b" }]);
	});
});

describe("applyEdits", () => {
	test("applies exact edits in order", () => {
		const result = applyEdits(SOURCE, [
			{ search: 'const SYSTEM = "Answer briefly.";', replace: 'const SYSTEM = "Think, then answer.";' },
			{ search: "\treturn reply.trim();", replace: "\treturn reply.trim().toLowerCase();" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toContain("Think, then answer.");
			expect(result.source).toContain("toLowerCase");
		}
	});

	test("does not interpret $ patterns in replacements", () => {
		const result = applyEdits(SOURCE, [{ search: "\treturn reply.trim();", replace: '\treturn "$&$1";' }]);
		expect(result.ok && result.source).toContain('return "$&$1";');
	});

	test("tolerates indentation drift when the match is unique", () => {
		const result = applyEdits(SOURCE, [{ search: "  return reply.trim();", replace: "\treturn reply;" }]);
		expect(result.ok && result.source).toContain("\treturn reply;");
	});

	test("rejects ambiguous and missing SEARCH text", () => {
		const ambiguous = applyEdits(`${SOURCE}\n${SOURCE}`, [{ search: "\treturn reply.trim();", replace: "x" }]);
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) expect(ambiguous.error).toContain("2 times");
		const missing = applyEdits(SOURCE, [{ search: "return nothing;", replace: "x" }]);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain("not found");
	});

	test("an empty SEARCH appends to the end", () => {
		const result = applyEdits(SOURCE, [{ search: "", replace: "function helper() { return 1; }" }]);
		expect(result.ok && result.source.endsWith("function helper() { return 1; }\n")).toBe(true);
	});

	test("normalizes CRLF sources", () => {
		const result = applyEdits("a\r\nb\r\n", [{ search: "b", replace: "c" }]);
		expect(result.ok && result.source).toBe("a\nc\n");
	});
});
