import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { propose } from "../src/core/proposer.ts";
import { screenHarness } from "../src/core/screens.ts";
import type { CapabilityName } from "../src/core/types.ts";
import { stubProposer } from "./helpers.ts";

const PARENT = "async function solve(question) {\n\treturn await llm(question);\n}\n";
const capabilities: CapabilityName[] = ["llm", "python"];
const base = {
	task: { name: "toy:addition", description: "Add two integers." },
	capabilities,
	budgets: DEFAULT_BUDGETS,
	parentSource: PARENT,
	parentScore: 0.4,
	feedbackSize: 10,
	report: "## Development results\nScore 0.400 on 10 questions.",
	maxLines: 100,
	attempts: 3,
	screen: (source: string) => screenHarness(source, { maxLines: 100 }),
};
const EDIT = [
	"## Diagnosis",
	"No answer extraction.",
	"## Edits",
	"<<<<<<< SEARCH",
	"\treturn await llm(question);",
	"=======",
	"\tconst reply = await llm(question);",
	"\treturn reply.trim();",
	">>>>>>> REPLACE",
	"## Change manifest",
	"Trim the reply.",
].join("\n");

describe("propose", () => {
	test("returns an applied, screened edit", async () => {
		const client = stubProposer(() => EDIT);
		const proposal = await propose({ ...base, client });
		expect(proposal.status).toBe("edit");
		expect(proposal.source).toContain("reply.trim()");
		expect(proposal.manifest).toBe("Trim the reply.");
		expect(proposal.attempts).toBe(1);
		expect(client.requests[0].system).toContain("async function solve(question)");
		expect(client.requests[0].messages[0].content).toContain("Score 0.400 on 10 questions.");
		expect(client.requests[0].messages[0].content).toContain(PARENT.trim());
	});

	test("retries with error feedback after an edit that does not apply", async () => {
		const client = stubProposer((_, call) =>
			call === 1 ? "<<<<<<< SEARCH\nnot in file\n=======\nx\n>>>>>>> REPLACE" : EDIT,
		);
		const proposal = await propose({ ...base, client });
		expect(proposal.status).toBe("edit");
		expect(proposal.attempts).toBe(2);
		expect(proposal.errors[0]).toContain("not found");
		const retry = client.requests[1].messages;
		expect(retry).toHaveLength(3);
		expect(retry[2].content).toContain("not found");
	});

	test("gives up after the attempt budget", async () => {
		const client = stubProposer(() => "I am not sure.");
		const proposal = await propose({ ...base, client, attempts: 2 });
		expect(proposal.status).toBe("invalid");
		expect(proposal.attempts).toBe(2);
		expect(proposal.parsed).toBe(false);
	});

	test("rejects edits that fail screening", async () => {
		const bad =
			"<<<<<<< SEARCH\n\treturn await llm(question);\n=======\n\treturn await llm(question;\n>>>>>>> REPLACE";
		const proposal = await propose({ ...base, client: stubProposer(() => bad), attempts: 1 });
		expect(proposal.status).toBe("invalid");
		expect(proposal.parsed).toBe(true);
		expect(proposal.reason).toContain("failed to load");
	});

	test("declared and effective no-change", async () => {
		const declared = await propose({ ...base, client: stubProposer(() => "NO_CHANGE: fine as is") });
		expect(declared.status).toBe("no_change");
		expect(declared.reason).toBe("fine as is");
		const same = await propose({
			...base,
			client: stubProposer(
				() =>
					"<<<<<<< SEARCH\n\treturn await llm(question);\n=======\n\treturn await llm(question);\n>>>>>>> REPLACE",
			),
		});
		expect(same.status).toBe("no_change");
	});

	test("adds a branch instruction for parallel proposals", async () => {
		const client = stubProposer(() => EDIT);
		await propose({ ...base, client, branch: { index: 2, total: 8 } });
		expect(client.requests[0].messages[0].content).toContain("proposal 3 of 8");
	});

	test("counts model errors as attempts", async () => {
		let call = 0;
		const proposal = await propose({
			...base,
			attempts: 2,
			client: {
				async complete() {
					call++;
					return call === 1
						? {
								text: "",
								stopReason: "error",
								usage: { input: 0, output: 0, cost: 0 },
								error: "ThrottlingException",
							}
						: { text: EDIT, stopReason: "stop", usage: { input: 1, output: 1, cost: 0 } };
				},
			},
		});
		expect(proposal.status).toBe("edit");
		expect(proposal.errors[0]).toContain("ThrottlingException");
	});
});
