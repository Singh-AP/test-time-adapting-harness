# Plan 3: Agentic Proposer on the pi SDK and a pi Package — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) A tool-using proposer that is a pi coding-agent session (paper App. F future work): it inspects and edits `harness.js` in a scratch workspace, validates it, and runs it on feedback questions before submitting. (2) A pi package that makes pi itself the host of test-time harness adaptation: an `adapt_harness` tool, an `/adapt` command, and `/harness-runs`.

**Architecture:** The loop accepts any `ProposeFn`. The agentic proposer creates a pi `AgentSession` (SDK) with path-guarded read/edit/write tools plus `check_harness` and `run_feedback`, then returns the edited file as a `Proposal`. The pi extension wraps the same engine behind an `AdaptService` so tests can inject stubs.

**Tech Stack:** Plan 1 stack plus `@earendil-works/pi-coding-agent` 1.1.0 (installed with `--save-exact`).

**Spec:** `docs/superpowers/specs/2026-10-12-test-time-adapting-harness-design.md` (D10, D11)

## Global Constraints

- All Plan 1 constraints.
- The agentic proposer may read and write only inside its workspace; `run_feedback` evaluates only `Q_fb` (never scoring or held-out questions) and is limited per proposal.
- The extension factory has no side effects: Bedrock clients are created when a run starts.

## Review Focus

1. An agent that edits nothing, or edits then reverts: reported as `no_change`. Pinned in Task 2 (`unchanged workspace is no_change`).
2. An agent that tries to read or write outside its workspace (absolute paths, `..`): the tool call fails. Pinned in Task 2 (`blocks paths outside the workspace`).
3. An agent that never finishes: the proposal times out, the session is aborted, and the candidate is screened as it stands. Pinned in Task 2 (`times out`).
4. A greedy round whose parent already scores 1.0: no proposals are sampled. Pinned in Task 1 (`skips proposals when the parent is perfect`).
5. `/adapt` with malformed arguments: a usage message, not a crash. Pinned in Task 4 (`parses /adapt arguments`).

---

### Task 1: Pluggable proposers, feedback context, perfect-parent skip

**Files:**
- Modify: `src/core/proposer.ts`, `src/core/loop.ts`, `src/core/independent.ts`, `src/core/edits.ts` (export `extractSection`), `test/loop.test.ts`

**Interfaces:**
- Produces: `FeedbackContext {task, questions, deps, concurrency}`, `ProposeOptions.client?` (optional), `ProposeOptions.feedback?`, `ProposeFn = (options: ProposeOptions) => Promise<Proposal>`; `AdaptDeps {solver, proposer?, propose?, python?}`; `AdaptConfig.skipPerfect?: boolean` (`REASONING_GYM_PROTOCOL.skipPerfect = true`, `QA_PROTOCOL.skipPerfect = false`); `extractSection(text, names)` exported from `edits.ts`.

- [ ] **Step 1: Write the failing tests** — append to `test/loop.test.ts`:

```ts
describe("pluggable proposers", () => {
	test("passes feedback context and meters proposal usage", async () => {
		const task = createArithmeticTask({ dev: 4, heldout: 3, seed: 21 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		const seen: string[][] = [];
		const summary = await adapt({
			task,
			seedSource: SEED,
			config: config({ rounds: 1 }),
			deps: {
				solver: solver(),
				python: stubPython(),
				propose: async (options) => {
					seen.push((options.feedback?.questions ?? []).map((q) => q.id));
					return {
						status: "no_change",
						reason: "custom",
						attempts: 1,
						parsed: true,
						applied: false,
						errors: [],
						system: "",
						transcript: [],
						usage: { input: 7, output: 3, cost: 0.5 },
					};
				},
			},
			runDir,
		});
		expect(seen).toEqual([task.dev.map((q) => q.id)]);
		expect(summary.usage.proposer).toMatchObject({ input: 7, output: 3, cost: 0.5, calls: 1 });
	});

	test("skips proposals when the parent is perfect", async () => {
		const task = createArithmeticTask({ dev: 4, heldout: 3, seed: 22 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		const proposer = stubProposer(() => IMPROVE);
		const summary = await adapt({
			task,
			seedSource: SEED.replace("await llm(question)", 'await llm({ system: "CAREFUL", prompt: question })'),
			config: config({ rounds: 2 }),
			deps: { solver: solver(), proposer, python: stubPython() },
			runDir,
		});
		expect(proposer.requests).toHaveLength(0);
		expect(summary.rounds[0].candidates).toEqual([]);
		expect(summary.rounds[0].selection.reason).toContain("perfect");
	});
});
```

Also update the first `adapt` test: with `skipPerfect` on, round 2 samples nothing because the round-1 harness is perfect. Replace its assertions on round 2 and on proposer calls with:
```ts
		expect(summary.rounds[1].candidates).toEqual([]);
		expect(summary.usage.proposer.calls).toBe(1);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/loop.test.ts`
Expected: FAIL (`propose` option unknown; perfect parent still samples).

- [ ] **Step 3: Implement**

In `src/core/proposer.ts`:
```ts
import type { Budgets, CapabilityDeps } from "./capabilities.ts";
import type { CapabilityName, ProposerClient, Question, SolverMessage, Task, TaskInfo, Usage } from "./types.ts";

/** What a tool-using proposer may run: the parent's feedback questions, never scoring or held-out questions. */
export interface FeedbackContext {
	task: Task;
	questions: readonly Question[];
	deps: CapabilityDeps;
	concurrency: number;
}

export type ProposeFn = (options: ProposeOptions) => Promise<Proposal>;
```
Make `ProposeOptions.client` optional and add `feedback?: FeedbackContext`. At the start of `propose()`:
```ts
	const client = o.client;
	if (!client) throw new Error("propose() needs a ProposerClient");
```
and use `client.complete(...)`.

In `src/core/edits.ts` export `extractSection`.

In `src/core/loop.ts`:
- `AdaptDeps { solver: SolverClient; proposer?: ProposerClient; propose?: ProposeFn; python?: PythonRunner }`.
- `AdaptConfig.skipPerfect?: boolean`; set `skipPerfect: true` in `REASONING_GYM_PROTOCOL` and `false` in `QA_PROTOCOL`.
- `const proposer = p.deps.proposer ? meterProposer(p.deps.proposer, meters.proposer) : undefined; const proposeFn = p.deps.propose ?? propose;`
- Before sampling: `const perfect = config.protocol === "greedy" && (config.skipPerfect ?? false) && parentScoreEval.mean >= 1 - 1e-9;` and sample `perfect ? 0 : config.proposals` proposals.
- Pass `client: proposer` and `feedback: { task, questions: feedback, deps, concurrency: config.concurrency }`.
- After proposals resolve, when `p.deps.propose` is set, add each `proposal.usage` to `meters.proposer`.
- When `perfect`, the selection reason is `parent is perfect on the scoring set (${fmt(parentScoreEval.mean)}); no proposals sampled`.

Apply the same `proposer`/`propose`/`feedback` changes to `src/core/independent.ts`.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/proposer.ts src/core/loop.ts src/core/independent.ts src/core/edits.ts test/loop.test.ts
git commit -m "feat: pluggable proposers with feedback context; skip proposals for a perfect greedy parent"
git push origin main
```

---

### Task 2: Agentic proposer on the pi coding-agent SDK

**Files:**
- Create: `src/proposers/agentic.ts`
- Test: `test/agentic.test.ts`

**Interfaces:**
- Consumes: `ProposeFn`, `ProposeOptions`, `Proposal`, `FeedbackContext` (Task 1); `evaluateHarness`, `buildReport`, `harnessApiDoc`, `extractSection` (Plan 1); pi `createAgentSession`, `ModelRuntime`, `SessionManager`, `SettingsManager`, `createExtensionRuntime`, `defineTool`, `createReadToolDefinition`, `createEditToolDefinition`, `createWriteToolDefinition`.
- Produces: `AgenticProposerOptions {runtime, model, thinkingLevel?, maxFeedbackRuns?, timeoutMs?, keepWorkspace?}`, `createAgenticProposer(options): ProposeFn`, `agenticSystemPrompt(options, maxFeedbackRuns)`, `guardPath(workspace, path)`.

- [ ] **Step 1: Write the failing test**

**Test: `test/agentic.test.ts`**
```ts
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { screenHarness } from "../src/core/screens.ts";
import { createAgenticProposer, guardPath } from "../src/proposers/agentic.ts";
import { createArithmeticTask } from "../src/tasks/toy.ts";
import { stubPython, stubSolver, sumInPrompt } from "./helpers.ts";

const PARENT = "async function solve(question) {\n\tconst reply = await llm(question);\n\treturn reply.trim();\n}\n";
const IMPROVED = 'async function solve(question) {\n\tconst reply = await llm({ system: "CAREFUL", prompt: question });\n\treturn reply.trim();\n}\n';

async function runtimeWith(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const dir = await mkdtemp(join(tmpdir(), "tta-agent-rt-"));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false });
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
			fauxAssistantMessage([fauxToolCall("write", { path: "harness.js", content: IMPROVED })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("check_harness", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("run_feedback", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("## Diagnosis\nNeeds care.\n## Change manifest\nAsk the solver to be careful.")]),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agentic.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**File: `src/proposers/agentic.ts`**
```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type Api, type Model, type ThinkingLevel, Type } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createEditToolDefinition,
	createExtensionRuntime,
	createReadToolDefinition,
	createWriteToolDefinition,
	defineTool,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { extractSection } from "../core/edits.ts";
import { evaluateHarness } from "../core/executor.ts";
import { harnessApiDoc } from "../core/prompts.ts";
import type { Proposal, ProposeFn, ProposeOptions } from "../core/proposer.ts";
import { buildReport } from "../core/report.ts";
import type { SolverMessage } from "../core/types.ts";
import { clip, errorMessage, fmt } from "../util/text.ts";

export interface AgenticProposerOptions {
	/** pi model runtime that resolves auth for `model`. */
	runtime: ModelRuntime;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel | "off";
	/** Evaluations on the feedback questions allowed per proposal (default 3). */
	maxFeedbackRuns?: number;
	/** Wall-clock limit per proposal (default 20 minutes). */
	timeoutMs?: number;
	keepWorkspace?: boolean;
}

/** Resolves a tool path inside the workspace or throws. */
export function guardPath(workspace: string, path: string): string {
	const target = resolve(workspace, path);
	const rel = relative(workspace, target);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside the workspace; only workspace files are available`);
	return target;
}

export function agenticSystemPrompt(o: ProposeOptions, maxFeedbackRuns: number): string {
	const feedback = o.feedback
		? `- run_feedback: run the current harness.js on the ${o.feedback.questions.length} development questions behind REPORT.md and get its score and failures (at most ${maxFeedbackRuns} runs; each run costs solver calls).`
		: "";
	return `You are an expert harness engineer working in a scratch workspace. A harness is a JavaScript program that answers the questions of one task by organizing calls to a fixed solver language model, tool use, and direct computation. You cannot change the solver model. You can change everything around it: prompts, the number and order of solver calls, answer parsing and normalization, verification and retries, voting, code execution, retrieval, and direct algorithmic computation in JavaScript.

Workspace files:
- harness.js: the current harness. Edit it in place.
- REPORT.md: execution report of the current harness on development questions.
- TASK.md: the task description and the harness API.

Tools:
- read, edit, write: workspace files only.
- check_harness: validate harness.js (loads in the sandbox, defines solve, line limit, no hard-coded development answers).
${feedback}

Rules:
- Keep the entry point \`async function solve(question)\`; it must return the final answer as a string in exactly the format the task expects.
- Do not hard-code answers or special-case particular development questions. The harness is evaluated on unseen questions.
- Keep harness.js under ${o.maxLines} lines.

Process: read REPORT.md and harness.js, diagnose the failures, edit harness.js, run check_harness, and use run_feedback to test the change when it is available. Stop when the harness is better or the budget is spent.

When finished, reply with:
## Diagnosis
What failed and why.
## Change manifest
One paragraph: what changed, which failures it should fix, and likely regressions.
If no change would help, leave harness.js unchanged and reply NO_CHANGE: <reason>.`;
}

function taskFile(o: ProposeOptions): string {
	return `# Task\nName: ${o.task.name}\n${o.task.description}\n\n# Harness API\n${harnessApiDoc(o.capabilities, o.budgets)}\n`;
}

function minimalResources(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

/** Wraps a built-in file tool so every path must resolve inside the workspace. */
function guarded(workspace: string, tool: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
	return {
		...tool,
		execute: (id, params, signal, onUpdate, ctx) => {
			guardPath(workspace, String((params as { path?: unknown }).path ?? ""));
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	};
}

function renderMessages(messages: readonly unknown[]): SolverMessage[] {
	const out: SolverMessage[] = [];
	for (const raw of messages) {
		const m = raw as { role?: string; content?: unknown; toolName?: string };
		const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [{ type: "text", text: String(m.content ?? "") }];
		const text = (b: Record<string, unknown>) => (typeof b.text === "string" ? b.text : "");
		if (m.role === "user") out.push({ role: "user", content: blocks.map(text).join("") });
		else if (m.role === "assistant") {
			const parts = blocks.map((b) =>
				b.type === "toolCall" ? `[tool call] ${String(b.name)}(${clip(JSON.stringify(b.arguments ?? {}), 600)})` : text(b),
			);
			out.push({ role: "assistant", content: parts.filter(Boolean).join("\n") });
		} else if (m.role === "toolResult") {
			out.push({ role: "user", content: `[tool result: ${m.toolName}] ${clip(blocks.map(text).join(""), 4000)}` });
		}
	}
	return out;
}

/** A proposer that is a pi coding-agent session editing harness.js in a scratch workspace (paper App. F). */
export function createAgenticProposer(a: AgenticProposerOptions): ProposeFn {
	const maxFeedbackRuns = a.maxFeedbackRuns ?? 3;
	return async (o): Promise<Proposal> => {
		const workspace = await mkdtemp(join(tmpdir(), "tta-agentic-"));
		const harnessPath = join(workspace, "harness.js");
		const parent = o.parentSource.replace(/\r\n/g, "\n");
		await writeFile(harnessPath, parent);
		await writeFile(join(workspace, "REPORT.md"), `# Development score ${fmt(o.parentScore)} on ${o.feedbackSize} questions\n\n${o.report}\n`);
		await writeFile(join(workspace, "TASK.md"), taskFile(o));
		const system = agenticSystemPrompt(o, maxFeedbackRuns);
		const errors: string[] = [];
		let feedbackRuns = 0;

		const check = defineTool({
			name: "check_harness",
			label: "Check harness",
			description: "Validate harness.js: it must load in the sandbox, define solve, stay under the line limit, and contain no hard-coded development answers.",
			parameters: Type.Object({}),
			execute: async () => {
				const result = await o.screen(await readFile(harnessPath, "utf8"));
				return { content: [{ type: "text", text: result.ok ? "OK: harness.js passes all checks." : `FAILED: ${result.reason}` }], details: undefined };
			},
		});
		const tools: ToolDefinition<any, any, any>[] = [
			guarded(workspace, createReadToolDefinition(workspace)),
			guarded(workspace, createEditToolDefinition(workspace)),
			guarded(workspace, createWriteToolDefinition(workspace)),
			check,
		];
		const feedback = o.feedback;
		if (feedback) {
			tools.push(
				defineTool({
					name: "run_feedback",
					label: "Run feedback questions",
					description: `Run the current harness.js on the ${feedback.questions.length} development questions behind REPORT.md and return its score and an execution report of failures. At most ${maxFeedbackRuns} runs.`,
					parameters: Type.Object({}),
					execute: async (_id, _params, signal) => {
						if (feedbackRuns >= maxFeedbackRuns) throw new Error(`run_feedback limit reached (${maxFeedbackRuns} runs)`);
						const source = await readFile(harnessPath, "utf8");
						const screened = await o.screen(source);
						if (!screened.ok) throw new Error(`harness.js does not pass check_harness: ${screened.reason}`);
						feedbackRuns++;
						const result = await evaluateHarness({
							task: feedback.task,
							source,
							questions: feedback.questions,
							label: `agentic-feedback-${feedbackRuns}`,
							deps: feedback.deps,
							budgets: o.budgets,
							concurrency: feedback.concurrency,
							signal,
						});
						const report = buildReport({ task: feedback.task, result, questions: feedback.questions, currentSource: source, history: [], maxFailures: 6, maxPasses: 1 });
						return {
							content: [{ type: "text", text: `Run ${feedbackRuns}/${maxFeedbackRuns}: score ${fmt(result.mean)} (parent ${fmt(o.parentScore)}).\n\n${report}` }],
							details: undefined,
						};
					},
				}),
			);
		}

		const branch = o.branch
			? `\n\nYou are proposal ${o.branch.index + 1} of ${o.branch.total} sampled independently; pursue option number ${o.branch.index + 1} in your own ranking of promising changes.`
			: "";
		const { session } = await createAgentSession({
			cwd: workspace,
			agentDir: join(workspace, ".pi"),
			modelRuntime: a.runtime,
			model: a.model,
			thinkingLevel: a.thinkingLevel === "off" ? undefined : (a.thinkingLevel ?? "medium"),
			noTools: "builtin",
			tools: tools.map((t) => t.name),
			customTools: tools,
			resourceLoader: minimalResources(system),
			sessionManager: SessionManager.inMemory(workspace),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3 } }),
		});
		const timer = setTimeout(() => {
			errors.push(`agentic proposer timed out after ${a.timeoutMs ?? 1_200_000} ms`);
			void session.abort();
		}, a.timeoutMs ?? 1_200_000);
		try {
			await session.prompt(
				`Improve harness.js for task ${o.task.name}. Its development score is ${fmt(o.parentScore)} on ${o.feedbackSize} questions; REPORT.md has the execution report.${branch}`,
			);
		} catch (error) {
			errors.push(`agent session error: ${errorMessage(error)}`);
		} finally {
			clearTimeout(timer);
		}
		const finalText = session.getLastAssistantText() ?? "";
		const stats = session.getSessionStats();
		const transcript = renderMessages(session.messages);
		session.dispose();
		const finalSource = (await readFile(harnessPath, "utf8")).replace(/\r\n/g, "\n");
		if (!a.keepWorkspace) await rm(workspace, { recursive: true, force: true });

		const base = {
			attempts: 1,
			parsed: true,
			errors,
			system,
			transcript,
			usage: { input: stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite, output: stats.tokens.output, cost: stats.cost },
			diagnosis: extractSection(finalText, ["diagnosis"]),
			manifest: extractSection(finalText, ["change manifest", "manifest"]),
		};
		if (finalSource === parent) {
			const declared = /NO_CHANGE\s*[:\-—]?\s*(.*)/.exec(finalText)?.[1]?.trim();
			return { ...base, status: "no_change", applied: false, reason: declared || "the agent left harness.js unchanged" };
		}
		const screened = await o.screen(finalSource);
		if (!screened.ok) return { ...base, status: "invalid", applied: false, reason: screened.reason };
		return { ...base, status: "edit", applied: true, source: finalSource };
	};
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/agentic.test.ts && npm test && npm run check`
Expected: all pass. If pi rejects custom tools named like built-ins, keep `noTools: "builtin"` and rename the guarded tools `read_file`, `edit_file`, `write_file` (update the test's tool calls and the system prompt).

- [ ] **Step 5: Commit**

```bash
git add src/proposers/agentic.ts test/agentic.test.ts package.json package-lock.json
git commit -m "feat: agentic proposer as a pi coding-agent session with guarded workspace tools"
git push origin main
```

---

### Task 3: CLI and suite support for the agentic proposer

**Files:**
- Modify: `src/cli.ts`, `experiments/rg-suite.ts`

**Interfaces:**
- Produces: CLI flags `--proposer-mode single|agentic` (default `single`), `--feedback-runs <n>` (default 3), `--agent-timeout <s>` (default 1200); the same flags on `experiments/rg-suite.ts`.

- [ ] **Step 1: Implement** — in both files, when `proposer-mode` is `agentic`:

```ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgenticProposer } from "./proposers/agentic.ts";
// ...
const agentDir = join(runDir, ".pi-agent");
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false });
const agentModel = runtime.getModel("amazon-bedrock", proposerId);
if (!agentModel) throw new Error(`Unknown Bedrock model ${proposerId}`);
const propose = createAgenticProposer({
	runtime,
	model: agentModel,
	thinkingLevel: reasoning ?? "off",
	maxFeedbackRuns: integer(values["feedback-runs"], 3),
	timeoutMs: integer(values["agent-timeout"], 1200) * 1000,
});
// deps: { solver, propose, python } instead of { solver, proposer, python }
```
(`experiments/rg-suite.ts` uses its own directory under `runs/<tag>-pi-agent` for `agentDir`.)

- [ ] **Step 2: Verify** — `npm run check && node src/cli.ts --help | grep proposer-mode`.

Live: `AWS_PROFILE=<aws-profile> node src/cli.ts adapt --task toy:addition --rounds 1 --dev 6 --heldout 6 --solver us.amazon.nova-micro-v1:0 --proposer-mode agentic --reasoning low`
Expected: one round completes; `round-01/candidates/c0/transcript.md` shows pi tool calls.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts experiments/rg-suite.ts README.md
git commit -m "feat: --proposer-mode agentic in the CLI and Reasoning Gym suite"
git push origin main
```

---

### Task 4: pi package: adapt_harness tool, /adapt and /harness-runs

**Files:**
- Create: `src/pi/service.ts`, `src/pi/extension.ts`
- Modify: `package.json` (`"pi": {"extensions": ["./src/pi/extension.ts"]}`, `"keywords": ["pi-package"]`), `README.md`
- Test: `test/pi-extension.test.ts`

**Interfaces:**
- Consumes: `createTask`, `adapt`, presets, Bedrock clients, `createPythonRunner`, `AdaptSummary`.
- Produces: `AdaptRequest {task, rounds?, proposals?, protocol?, solver?, proposer?, reasoning?, dev?, heldout?, seedHarness?, runDir?}`, `AdaptService {run(request, log, signal?)}`, `createAdaptService()`, `parseAdaptArgs(args): AdaptRequest`, `formatSummary(summary): string`, `createAdaptExtension(service?)`, default export (the extension factory).

- [ ] **Step 1: Write the failing test**

**Test: `test/pi-extension.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import type { AdaptSummary } from "../src/core/loop.ts";
import { createAdaptExtension, formatSummary, parseAdaptArgs } from "../src/pi/extension.ts";
import type { AdaptRequest, AdaptService } from "../src/pi/service.ts";

const SUMMARY: AdaptSummary = {
	task: "toy:addition",
	runDir: "/tmp/run",
	seedHeldout: 0.25,
	finalHeldout: 0.75,
	rounds: [],
	finalHash: "abc",
	usage: { solver: { input: 1, output: 1, cost: 0.01, calls: 2 }, proposer: { input: 1, output: 1, cost: 0.2, calls: 1 } },
};

function fakePi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const messages: unknown[] = [];
	return {
		tools,
		commands,
		messages,
		api: {
			registerTool: (tool: any) => tools.set(tool.name, tool),
			registerCommand: (name: string, options: any) => commands.set(name, options),
			sendMessage: (message: unknown) => messages.push(message),
		},
	};
}

describe("pi extension", () => {
	test("parses /adapt arguments", () => {
		expect(parseAdaptArgs("rg:maze --rounds 3 --proposals 2 --protocol qa --solver s --dev 10")).toEqual({
			task: "rg:maze",
			rounds: 3,
			proposals: 2,
			protocol: "qa",
			solver: "s",
			dev: 10,
		});
		expect(() => parseAdaptArgs("")).toThrow("Usage: /adapt");
		expect(() => parseAdaptArgs("rg:maze --rounds x")).toThrow("--rounds");
	});

	test("adapt_harness runs the service and summarizes", async () => {
		const requests: AdaptRequest[] = [];
		const service: AdaptService = {
			run: async (request, log) => {
				requests.push(request);
				log("round 1 done");
				return SUMMARY;
			},
		};
		const pi = fakePi();
		createAdaptExtension(service)(pi.api as never);
		const tool = pi.tools.get("adapt_harness");
		const updates: string[] = [];
		const result = await tool.execute("id", { task: "toy:addition", rounds: 1 }, undefined, (u: any) => updates.push(u.content[0].text), {});
		expect(requests[0]).toMatchObject({ task: "toy:addition", rounds: 1 });
		expect(updates).toContain("round 1 done");
		expect(result.content[0].text).toContain("0.250 -> 0.750");
		expect(pi.commands.has("adapt")).toBe(true);
		expect(pi.commands.has("harness-runs")).toBe(true);
	});

	test("formatSummary reports held-out scores, cost and artifacts", () => {
		const text = formatSummary(SUMMARY);
		expect(text).toContain("toy:addition");
		expect(text).toContain("/tmp/run");
		expect(text).toContain("$0.21");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi-extension.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**File: `src/pi/service.ts`**
```ts
import { readFile } from "node:fs/promises";
import { DEFAULT_PROPOSER_MODEL, DEFAULT_SOLVER_MODEL, defaultPythonPath, repoPath } from "../config.ts";
import { DEFAULT_BUDGETS } from "../core/capabilities.ts";
import { type AdaptSummary, adapt, QA_PROTOCOL, REASONING_GYM_PROTOCOL } from "../core/loop.ts";
import { createBedrockModels, PiProposerClient, PiSolverClient, requireModel } from "../llm/pi-clients.ts";
import { createTask } from "../tasks/registry.ts";
import { createPythonRunner } from "../tools/python.ts";
import { Semaphore } from "../util/concurrency.ts";

export interface AdaptRequest {
	task: string;
	rounds?: number;
	proposals?: number;
	protocol?: "rg" | "qa";
	solver?: string;
	proposer?: string;
	reasoning?: "off" | "minimal" | "low" | "medium" | "high";
	dev?: number;
	heldout?: number;
	seedHarness?: string;
	runDir?: string;
}

export interface AdaptService {
	run(request: AdaptRequest, log: (line: string) => void, signal?: AbortSignal): Promise<AdaptSummary>;
}

/** Runs the adaptation loop on Bedrock models; nothing is created until run() is called. */
export function createAdaptService(): AdaptService {
	return {
		async run(request, log, signal) {
			process.env.AWS_REGION ??= "us-east-1";
			const task = await createTask(request.task, { devSize: request.dev, heldoutSize: request.heldout });
			try {
				const models = createBedrockModels();
				const solver = new PiSolverClient({
					models,
					model: requireModel(models, request.solver ?? process.env.TTA_SOLVER_MODEL ?? DEFAULT_SOLVER_MODEL),
					limiter: new Semaphore(16),
					temperature: 0.7,
				});
				const reasoning = request.reasoning ?? "medium";
				const proposer = new PiProposerClient({
					models,
					model: requireModel(models, request.proposer ?? process.env.TTA_PROPOSER_MODEL ?? DEFAULT_PROPOSER_MODEL),
					reasoning: reasoning === "off" ? undefined : reasoning,
				});
				const preset = request.protocol === "qa" ? QA_PROTOCOL : REASONING_GYM_PROTOCOL;
				const defaultSeed = task.name.startsWith("qa:") ? "qa-seed.js" : "rg-seed.js";
				const seedSource = await readFile(request.seedHarness ?? repoPath("seeds", defaultSeed), "utf8");
				const time = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				return await adapt({
					task,
					seedSource,
					config: {
						...preset,
						rounds: request.rounds ?? preset.rounds,
						proposals: request.proposals ?? preset.proposals,
						budgets: DEFAULT_BUDGETS,
						concurrency: 8,
						seed: 1,
					},
					deps: { solver, proposer, python: createPythonRunner({ pythonPath: defaultPythonPath() }) },
					runDir: request.runDir ?? repoPath("runs", `${time}-pi-${request.task.replace(/[^\w]+/g, "_")}`),
					log,
					signal,
				});
			} finally {
				await task.close?.();
			}
		},
	};
}
```

**File: `src/pi/extension.ts`**
```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { repoPath } from "../config.ts";
import type { AdaptSummary } from "../core/loop.ts";
import { fmt } from "../util/text.ts";
import { type AdaptRequest, type AdaptService, createAdaptService } from "./service.ts";

const USAGE =
	"Usage: /adapt <task> [--rounds N] [--proposals G] [--protocol rg|qa] [--solver ID] [--proposer ID] [--reasoning LEVEL] [--dev N] [--heldout N] [--seed-harness FILE] [--run-dir DIR]";

const NUMERIC = new Set(["rounds", "proposals", "dev", "heldout"]);
const KEYS: Record<string, keyof AdaptRequest> = {
	rounds: "rounds",
	proposals: "proposals",
	protocol: "protocol",
	solver: "solver",
	proposer: "proposer",
	reasoning: "reasoning",
	dev: "dev",
	heldout: "heldout",
	"seed-harness": "seedHarness",
	"run-dir": "runDir",
};

export function parseAdaptArgs(args: string): AdaptRequest {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const task = words.shift();
	if (!task || task.startsWith("--")) throw new Error(USAGE);
	const request: Record<string, unknown> = { task };
	while (words.length > 0) {
		const flag = words.shift() as string;
		const name = flag.replace(/^--/, "");
		const key = KEYS[name];
		const value = words.shift();
		if (!flag.startsWith("--") || !key || value === undefined) throw new Error(`Unknown or incomplete option ${flag}. ${USAGE}`);
		if (NUMERIC.has(name)) {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} expects a non-negative integer. ${USAGE}`);
			request[key] = n;
		} else request[key] = value;
	}
	return request as unknown as AdaptRequest;
}

export function formatSummary(s: AdaptSummary): string {
	const score = (x: number | undefined) => (x === undefined ? "-" : fmt(x));
	const rounds = s.rounds.map((r) => `- round ${r.round}: ${r.selection.reason}; held-out ${score(r.heldout)}`);
	const cost = s.usage.solver.cost + s.usage.proposer.cost;
	return [
		`Adapted ${s.task}: held-out ${score(s.seedHeldout)} -> ${score(s.finalHeldout)}.`,
		...rounds,
		`Cost $${cost.toFixed(2)} (solver ${s.usage.solver.calls} calls, proposer ${s.usage.proposer.calls} calls). Final harness: ${join(s.runDir, "final.js")}.`,
	].join("\n");
}

/** pi extension: test-time harness adaptation as a tool and commands. */
export function createAdaptExtension(service: AdaptService = createAdaptService()) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "adapt_harness",
			label: "Adapt harness",
			description:
				"Adapt an agent harness to a task at test time (harness learning): a proposer model revises the harness program from execution feedback on development questions, and held-out scores are reported every round. Tasks: toy:addition, rg:<reasoning-gym family>, qa:hotpotqa|musique|2wiki. Runs can take minutes.",
			parameters: Type.Object({
				task: Type.String({ description: "Task spec, for example rg:maze or qa:hotpotqa" }),
				rounds: Type.Optional(Type.Integer({ minimum: 1, description: "Revision rounds" })),
				proposals: Type.Optional(Type.Integer({ minimum: 1, description: "Proposals per round" })),
				protocol: Type.Optional(Type.Union([Type.Literal("rg"), Type.Literal("qa")])),
				solver: Type.Optional(Type.String({ description: "Bedrock solver model id" })),
				proposer: Type.Optional(Type.String({ description: "Bedrock proposer model id" })),
				dev: Type.Optional(Type.Integer({ minimum: 1 })),
				heldout: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			execute: async (_id, params, signal, onUpdate) => {
				const summary = await service.run(
					params as AdaptRequest,
					(line) => onUpdate?.({ content: [{ type: "text", text: line }], details: undefined }),
					signal,
				);
				return {
					content: [{ type: "text", text: formatSummary(summary) }],
					details: { runDir: summary.runDir, seedHeldout: summary.seedHeldout, finalHeldout: summary.finalHeldout },
				};
			},
		});

		pi.registerCommand("adapt", {
			description: "Adapt a harness to a task at test time. /adapt <task> [--rounds N] ...",
			handler: async (args, ctx) => {
				let request: AdaptRequest;
				try {
					request = parseAdaptArgs(args);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				ctx.ui.notify(`Adapting ${request.task}; progress appears in the status line.`, "info");
				try {
					const summary = await service.run(request, (line) => ctx.ui.setStatus("adapt", line));
					pi.sendMessage({ customType: "adapt-result", content: formatSummary(summary), display: true });
				} catch (error) {
					ctx.ui.notify(`Adaptation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				} finally {
					ctx.ui.setStatus("adapt", undefined);
				}
			},
		});

		pi.registerCommand("harness-runs", {
			description: "List test-time adaptation runs and their held-out scores",
			handler: async (_args, ctx) => {
				const dir = repoPath("runs");
				const names = (await readdir(dir).catch(() => [] as string[])).sort().slice(-20);
				const lines: string[] = [];
				for (const name of names) {
					const summary = await readFile(join(dir, name, "summary.json"), "utf8").catch(() => undefined);
					if (!summary) continue;
					const s = JSON.parse(summary) as AdaptSummary;
					lines.push(`${name}: ${s.task} ${s.seedHeldout?.toFixed(3) ?? "-"} -> ${s.finalHeldout?.toFixed(3) ?? "-"}`);
				}
				ctx.ui.notify(lines.length ? lines.join("\n") : "No completed runs.", "info");
			},
		});
	};
}

export default createAdaptExtension();
```

Add to `package.json`:
```json
	"keywords": ["pi-package"],
	"pi": { "extensions": ["./src/pi/extension.ts"] },
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/pi-extension.test.ts && npm test && npm run check`
Expected: all pass.

- [ ] **Step 5: End-to-end through the pi CLI**

Run:
```bash
export AWS_PROFILE=<aws-profile> AWS_REGION=us-east-1
node_modules/.bin/pi -p --no-session --provider amazon-bedrock --model us.anthropic.claude-sonnet-5 --tools adapt_harness -e ./src/pi/extension.ts \
  "Use the adapt_harness tool on task toy:addition with rounds 1, dev 6, heldout 6, solver us.amazon.nova-micro-v1:0. Then report the seed and final held-out scores and where the final harness was written."
```
Expected: pi calls `adapt_harness`; the final answer states both held-out scores and the `final.js` path.

- [ ] **Step 6: Commit**

```bash
git add src/pi package.json README.md test/pi-extension.test.ts
git commit -m "feat: pi package with adapt_harness tool, /adapt and /harness-runs"
git push origin main
```

---

### Task 5: Agentic versus single-shot runs

**Files:**
- Create: `results/reasoning-gym-agentic.md`

- [ ] **Step 1: Run** the Reasoning Gym suite twice on the same families, once per proposer mode, with a weaker proposer so that one revision does not saturate (for example `us.anthropic.claude-haiku-4-5-20251001-v1:0`):

```bash
export AWS_PROFILE=<aws-profile>
node experiments/rg-suite.ts --families <families> --proposer <id> --tag rg-single-weak --out results/reasoning-gym-weak-single.md
node experiments/rg-suite.ts --families <families> --proposer <id> --proposer-mode agentic --tag rg-agentic-weak --out results/reasoning-gym-agentic.md
```

- [ ] **Step 2: Commit**

```bash
git add results/
git commit -m "feat: agentic versus single-shot proposer results"
git push origin main
```
