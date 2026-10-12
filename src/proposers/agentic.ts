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
	ModelRuntime,
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
	if (rel.startsWith("..") || isAbsolute(rel))
		throw new Error(`${path} is outside the workspace; only workspace files are available`);
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
- TASK.md: the task description and the harness API.${o.playbook ? "\n- PLAYBOOK.md: lessons from adapting harnesses on other tasks." : ""}

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
		const blocks = Array.isArray(m.content)
			? (m.content as Record<string, unknown>[])
			: [{ type: "text", text: String(m.content ?? "") }];
		const text = (b: Record<string, unknown>) => (typeof b.text === "string" ? b.text : "");
		if (m.role === "user") out.push({ role: "user", content: blocks.map(text).join("") });
		else if (m.role === "assistant") {
			const parts = blocks.map((b) =>
				b.type === "toolCall"
					? `[tool call] ${String(b.name)}(${clip(JSON.stringify(b.arguments ?? {}), 600)})`
					: text(b),
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
		await writeFile(
			join(workspace, "REPORT.md"),
			`# Development score ${fmt(o.parentScore)} on ${o.feedbackSize} questions\n\n${o.report}\n`,
		);
		await writeFile(join(workspace, "TASK.md"), taskFile(o));
		if (o.playbook)
			await writeFile(
				join(workspace, "PLAYBOOK.md"),
				`# Lessons from previous adaptations (other tasks)\n\n${o.playbook.trim()}\n`,
			);
		const system = agenticSystemPrompt(o, maxFeedbackRuns);
		const errors: string[] = [];
		let feedbackRuns = 0;

		const check = defineTool({
			name: "check_harness",
			label: "Check harness",
			description:
				"Validate harness.js: it must load in the sandbox, define solve, stay under the line limit, and contain no hard-coded development answers.",
			parameters: Type.Object({}),
			execute: async () => {
				const result = await o.screen(await readFile(harnessPath, "utf8"));
				return {
					content: [
						{ type: "text", text: result.ok ? "OK: harness.js passes all checks." : `FAILED: ${result.reason}` },
					],
					details: undefined,
				};
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
						if (feedbackRuns >= maxFeedbackRuns)
							throw new Error(`run_feedback limit reached (${maxFeedbackRuns} runs)`);
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
						const report = buildReport({
							task: feedback.task,
							result,
							questions: feedback.questions,
							currentSource: source,
							history: [],
							maxFailures: 6,
							maxPasses: 1,
						});
						return {
							content: [
								{
									type: "text",
									text: `Run ${feedbackRuns}/${maxFeedbackRuns}: score ${fmt(result.mean)} (parent ${fmt(o.parentScore)}).\n\n${report}`,
								},
							],
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
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 3 },
			}),
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
			usage: {
				input: stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite,
				output: stats.tokens.output,
				cost: stats.cost,
			},
			diagnosis: extractSection(finalText, ["diagnosis"]),
			manifest: extractSection(finalText, ["change manifest", "manifest"]),
		};
		if (finalSource === parent) {
			const declared = /NO_CHANGE\s*[:\-—]?\s*(.*)/.exec(finalText)?.[1]?.trim();
			return {
				...base,
				status: "no_change",
				applied: false,
				reason: declared || "the agent left harness.js unchanged",
			};
		}
		const screened = await o.screen(finalSource);
		if (!screened.ok) return { ...base, status: "invalid", applied: false, reason: screened.reason };
		return { ...base, status: "edit", applied: true, source: finalSource };
	};
}

/** Agentic proposer on a Bedrock model, with a pi model runtime stored under `agentDir`. */
export async function createBedrockAgenticProposer(o: {
	agentDir: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel | "off";
	maxFeedbackRuns?: number;
	timeoutMs?: number;
}): Promise<ProposeFn> {
	const runtime = await ModelRuntime.create({
		authPath: join(o.agentDir, "auth.json"),
		modelsPath: join(o.agentDir, "models.json"),
		refreshOnCreate: false,
	});
	const model = runtime.getModel("amazon-bedrock", o.modelId);
	if (!model) throw new Error(`Unknown amazon-bedrock model "${o.modelId}"`);
	return createAgenticProposer({
		runtime,
		model,
		thinkingLevel: o.thinkingLevel,
		maxFeedbackRuns: o.maxFeedbackRuns,
		timeoutMs: o.timeoutMs,
	});
}
