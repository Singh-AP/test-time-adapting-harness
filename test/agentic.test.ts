import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { screenHarness } from "../src/core/screens.ts";
import {
	agenticSystemPrompt,
	createAgenticProposer,
	createAgenticProposerForModel,
	guardPath,
} from "../src/proposers/agentic.ts";
import { createArithmeticTask } from "../src/tasks/toy.ts";
import { stubPython, stubSolver, sumInPrompt } from "./helpers.ts";

const PARENT = "async function solve(question) {\n\tconst reply = await llm(question);\n\treturn reply.trim();\n}\n";
const IMPROVED =
	'async function solve(question) {\n\tconst reply = await llm({ system: "CAREFUL", prompt: question });\n\treturn reply.trim();\n}\n';

async function runtimeWith(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const dir = await mkdtemp(join(tmpdir(), "tta-agent-rt-"));
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		refreshOnCreate: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider(faux.provider);
	faux.setResponses(steps);
	return { runtime, model: faux.getModel() };
}

function options(extra: Record<string, unknown> = {}) {
	const task = createArithmeticTask({ dev: 3, heldout: 2, seed: 4 });
	const solver = stubSolver((r) => {
		const sum = sumInPrompt(r.messages[0].content) ?? 0;
		return String(r.system === "CAREFUL" ? sum : sum + 1);
	});
	return {
		task,
		capabilities: task.capabilities,
		budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 },
		parentSource: PARENT,
		parentScore: 0,
		feedbackSize: task.dev.length,
		report: "## Development results\nScore 0.000 on 3 questions.",
		maxLines: 100,
		attempts: 1,
		screen: (source: string) => screenHarness(source, { maxLines: 100 }),
		feedback: { task, questions: task.dev, deps: { solver, python: stubPython() }, concurrency: 2 },
		...extra,
	};
}

describe("agentic proposer", () => {
	test("edits harness.js with pi tools, checks it, runs feedback, and returns the edit", async () => {
		const { runtime, model } = await runtimeWith([
			fauxAssistantMessage([fauxToolCall("read", { path: "REPORT.md" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "harness.js", content: IMPROVED })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("check_harness", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("run_feedback", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxText("## Diagnosis\nNeeds care.\n## Change manifest\nAsk the solver to be careful."),
			]),
		]);
		const propose = createAgenticProposer({ runtime, model, thinkingLevel: "off", maxFeedbackRuns: 2 });
		const proposal = await propose(options());
		expect(proposal.status).toBe("edit");
		expect(proposal.source).toBe(IMPROVED);
		expect(proposal.manifest).toBe("Ask the solver to be careful.");
		const tools = proposal.transcript.map((m) => m.content).join("\n");
		expect(tools).toContain("[tool result: check_harness] OK");
		expect(tools).toContain("score 1.000");
	});

	test("unchanged workspace is no_change", async () => {
		const { runtime, model } = await runtimeWith([fauxAssistantMessage([fauxText("NO_CHANGE: already fine")])]);
		const proposal = await createAgenticProposer({ runtime, model, thinkingLevel: "off" })(options());
		expect(proposal.status).toBe("no_change");
		expect(proposal.reason).toContain("already fine");
	});

	test("blocks paths outside the workspace", async () => {
		expect(() => guardPath("/tmp/ws", "../etc/passwd")).toThrow("outside the workspace");
		expect(() => guardPath("/tmp/ws", "/etc/passwd")).toThrow("outside the workspace");
		expect(guardPath("/tmp/ws", "harness.js")).toBe("/tmp/ws/harness.js");
	});

	test("blocks pi's @ and ~ path forms that escape the workspace", () => {
		expect(() => guardPath("/tmp/ws", "@/etc/passwd")).toThrow("outside the workspace");
		expect(() => guardPath("/tmp/ws", "~/.aws/credentials")).toThrow("outside the workspace");
		expect(() => guardPath("/tmp/ws", "~")).toThrow("outside the workspace");
		expect(guardPath("/tmp/ws", "@harness.js")).toBe("/tmp/ws/harness.js");
	});

	test("agentic system prompt forbids copying development text, even as examples", () => {
		expect(agenticSystemPrompt(options(), 3)).toContain("not even as examples");
	});

	test("times out", async () => {
		const { runtime, model } = await runtimeWith([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				return fauxAssistantMessage([fauxText("late")]);
			},
		]);
		const proposal = await createAgenticProposer({ runtime, model, thinkingLevel: "off", timeoutMs: 200 })(options());
		expect(proposal.status).toBe("no_change");
		expect(proposal.errors.join(" ")).toContain("timed out");
	});
});

describe("createAgenticProposerForModel", () => {
	test("takes provider/model specs of any built-in provider and rejects unknown models", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "tta-agent-dir-"));
		expect(typeof (await createAgenticProposerForModel({ agentDir, model: "anthropic/claude-sonnet-5-5" }))).toBe(
			"function",
		);
		expect(typeof (await createAgenticProposerForModel({ agentDir, model: "us.anthropic.claude-opus-5-5" }))).toBe(
			"function",
		);
		await expect(createAgenticProposerForModel({ agentDir, model: "anthropic/no-such-model" })).rejects.toThrow(
			/Unknown anthropic model "no-such-model"/,
		);
	});
});
