import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { guardPath } from "../proposers/agentic.ts";
import { errorMessage } from "../util/text.ts";
import { renderTranscript } from "./agent.ts";
import { loadHarness } from "./harness.ts";

/** Files the proposer may change; everything else in the workspace is context. */
export const HARNESS_FILES = [
	"harness.json",
	"system.md",
	"user.md",
	"probe.sh",
	"finish.md",
	"review.md",
	"review-request.md",
	"review-followup.md",
];
const MAX_PROMPT_CHARS = 24_000;
const SETTING_KEYS = new Set([
	"name",
	"thinkingLevel",
	"maxFinishChecks",
	"bash",
	"contextWindow",
	"compaction",
	"timeWarnings",
	"review",
	"maxLengthRecoveries",
	"continuePrompt",
]);

export interface ScreenResult {
	ok: boolean;
	reason?: string;
}

/** Static checks on a harness directory before it is run on any task. */
export async function screenHarnessDir(dir: string, o: { forbidden: string[] }): Promise<ScreenResult> {
	let config: Record<string, unknown>;
	try {
		config = JSON.parse(await readFile(join(dir, "harness.json"), "utf8"));
	} catch (error) {
		return { ok: false, reason: `harness.json does not parse: ${errorMessage(error)}` };
	}
	const unknown = Object.keys(config).filter((k) => !SETTING_KEYS.has(k));
	if (unknown.length) return { ok: false, reason: `harness.json has unknown keys: ${unknown.join(", ")}` };
	let harness: Awaited<ReturnType<typeof loadHarness>>;
	try {
		harness = await loadHarness(dir);
	} catch (error) {
		return { ok: false, reason: `harness does not load: ${errorMessage(error)}` };
	}
	const { bash } = harness;
	if (!(bash.defaultTimeoutSec > 0 && bash.defaultTimeoutSec <= bash.maxTimeoutSec && bash.maxTimeoutSec <= 7200))
		return { ok: false, reason: "bash timeouts must satisfy 0 < defaultTimeoutSec <= maxTimeoutSec <= 7200" };
	if (!(harness.contextWindow >= 100_000 && harness.contextWindow <= 1_000_000))
		return { ok: false, reason: "contextWindow must be between 100000 and 1000000" };
	if (!harness.userPrompt.includes("{{instruction}}"))
		return { ok: false, reason: "user.md must contain {{instruction}}" };
	if (harness.review) {
		if (!harness.review.request.includes("{{instruction}}"))
			return { ok: false, reason: "review-request.md must contain {{instruction}}" };
		if (!harness.review.followup.includes("{{issues}}"))
			return { ok: false, reason: "review-followup.md must contain {{issues}}" };
		if (!(harness.review.maxRounds >= 0 && harness.review.maxRounds <= 5))
			return { ok: false, reason: "review.maxRounds must be between 0 and 5" };
	}
	const texts: string[] = [];
	for (const file of HARNESS_FILES) texts.push(await readFile(join(dir, file), "utf8").catch(() => ""));
	const total = texts.reduce((n, t) => n + t.length, 0);
	if (total > MAX_PROMPT_CHARS)
		return { ok: false, reason: `harness files total ${total} characters; the limit is ${MAX_PROMPT_CHARS}` };
	const haystack = texts.join("\n").toLowerCase();
	for (const word of o.forbidden) {
		if (word.trim().length >= 4 && haystack.includes(word.toLowerCase()))
			return {
				ok: false,
				reason: `the harness mentions "${word}", a development task or hidden test name; keep the harness task-agnostic`,
			};
	}
	return { ok: true };
}

const GUIDE = `# The harness

A fixed model solves Terminal-Bench tasks: hard, realistic tasks in a Linux container, graded by hidden tests that check the final container state against the task statement, all or nothing per task. The harness is everything around the model:

- system.md: the agent's system prompt.
- user.md: the first user message. {{instruction}} is the task statement, {{environment}} the output of probe.sh, {{time_budget}} the wall-clock budget.
- probe.sh: a shell script run in the container before the first turn; its output fills {{environment}}.
- finish.md: sent when the agent first stops, asking it to verify ({{time_left}} available). Empty disables it.
- review.md, review-request.md, review-followup.md: an independent reviewer (fresh context, bash and read tools) audits the container after the agent stops. review-request.md is its first message ({{instruction}}, {{summary}}, {{time_left}}). It must end with "VERDICT: PASS" or "VERDICT: FAIL" and numbered issues; on FAIL, review-followup.md ({{issues}}, {{time_left}}) goes back to the agent. Deleting review.md disables reviews.
- harness.json: thinkingLevel (off|minimal|low|medium|high|xhigh|max), maxFinishChecks, bash {defaultTimeoutSec, maxTimeoutSec, headBytes, tailBytes}, contextWindow (compaction triggers near it), compaction {enabled, reserveTokens, keepRecentTokens}, timeWarnings (fractions of the budget at which the agent is told the remaining time), review {maxRounds, minTimeLeftSec}, maxLengthRecoveries and continuePrompt (what happens when a reply is cut off by the output limit).

Tools the agent has: bash (fresh shell per call, stdin is /dev/null, output capped to head and tail, timeout), read, edit, write.
`;

function systemPrompt(): string {
	return `You are an expert engineer of agent harnesses. You improve the harness around a fixed model that solves hard terminal tasks. You cannot change the model or add tools; you can change the prompts, the probe script, the verification and review protocol, and the settings described in GUIDE.md.

Workspace: GUIDE.md (the harness format), REPORT.md (results of the current harness on development tasks, with failure details), HISTORY.md if present (earlier changes and their measured effects), and the harness files themselves.

Rules:
- Improve general capability on unseen tasks. The harness will be evaluated on other tasks than the ones in REPORT.md. Never mention specific tasks, their files, data, tools or hidden tests; write guidance that would help on any hard terminal task.
- Diagnose failure patterns across tasks (stopping early, unverified requirements, misread specs, timeouts, environment problems, broken tooling use) and target the most common, most fixable ones.
- Keep the prompts tight. Longer is not better; the harness files together must stay under ${MAX_PROMPT_CHARS} characters.
- Run check_harness after editing; it must pass.

When finished, reply with:
## Diagnosis
The failure patterns you found, with the tasks they explain.
## Change manifest
One paragraph: what changed, which failure patterns it should fix, and the likely regressions.
If no change would help, leave the files unchanged and reply NO_CHANGE: <reason>.`;
}

function resources(prompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => prompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function guarded(workspace: string, tool: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
	return {
		...tool,
		execute: (id, params, signal, onUpdate, ctx) => {
			guardPath(workspace, String((params as { path?: unknown }).path ?? ""));
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	};
}

async function harnessSnapshot(dir: string): Promise<string> {
	const parts: string[] = [];
	for (const file of HARNESS_FILES) parts.push(`${file}\n${await readFile(join(dir, file), "utf8").catch(() => "")}`);
	return parts.join("\n\u0000\n");
}

export interface HarnessProposalOptions {
	runtime: ModelRuntime;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel | "off";
	parentDir: string;
	outDir: string;
	report: string;
	history?: string;
	/** Development task names and hidden test names the harness must not mention. */
	forbidden: string[];
	timeoutMs?: number;
	/** Where to keep the proposer transcript (default: outDir/PROPOSAL.md when an edit is written). */
	transcriptPath?: string;
}

export interface HarnessProposal {
	status: "edit" | "no_change" | "invalid" | "error";
	diagnosis: string;
	manifest: string;
	reason?: string;
	cost: number;
	transcript: string;
}

/** One agentic proposal: a pi session edits a copy of the parent harness (paper Eq. 4 with App. F's agent). */
export async function proposeHarness(o: HarnessProposalOptions): Promise<HarnessProposal> {
	const workspace = await mkdtemp(join(tmpdir(), "tta-harness-proposal-"));
	try {
		await cp(o.parentDir, workspace, { recursive: true });
		for (const extra of ["CHANGES.md", "PROPOSAL.md"]) await rm(join(workspace, extra), { force: true });
		await writeFile(join(workspace, "GUIDE.md"), GUIDE);
		await writeFile(join(workspace, "REPORT.md"), o.report);
		if (o.history) await writeFile(join(workspace, "HISTORY.md"), o.history);
		const before = await harnessSnapshot(workspace);
		const check = defineTool({
			name: "check_harness",
			label: "Check harness",
			description: "Validate the harness files: settings, placeholders, size limit, and no task-specific content.",
			parameters: Type.Object({}),
			execute: async () => {
				const r = await screenHarnessDir(workspace, { forbidden: o.forbidden });
				return {
					content: [{ type: "text", text: r.ok ? "OK: the harness passes all checks." : `FAILED: ${r.reason}` }],
					details: undefined,
				};
			},
		});
		const tools = [
			guarded(workspace, createReadToolDefinition(workspace)),
			guarded(workspace, createEditToolDefinition(workspace)),
			guarded(workspace, createWriteToolDefinition(workspace)),
			check,
		];
		const { session } = await createAgentSession({
			cwd: workspace,
			agentDir: join(workspace, ".pi"),
			modelRuntime: o.runtime,
			model: o.model,
			thinkingLevel: o.thinkingLevel === "off" ? undefined : (o.thinkingLevel ?? "high"),
			noTools: "builtin",
			tools: tools.map((t) => t.name),
			customTools: tools,
			resourceLoader: resources(systemPrompt()),
			sessionManager: SessionManager.inMemory(workspace),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 6 },
			}),
		});
		const errors: string[] = [];
		const timer = setTimeout(() => void session.abort(), o.timeoutMs ?? 1_800_000);
		try {
			await session.prompt(
				"Improve the harness in this workspace. Start with GUIDE.md and REPORT.md, then read the harness files.",
			);
		} catch (error) {
			errors.push(errorMessage(error));
		} finally {
			clearTimeout(timer);
		}
		const finalText = session.getLastAssistantText() ?? "";
		const cost = session.getSessionStats().cost;
		const transcript = renderTranscript(session.messages);
		session.dispose();
		const base = {
			diagnosis: extractSection(finalText, ["diagnosis"]) ?? "",
			manifest: extractSection(finalText, ["change manifest", "manifest"]) ?? "",
			cost,
			transcript,
		};
		if (o.transcriptPath) await writeFile(o.transcriptPath, transcript);
		if (errors.length) return { ...base, status: "error", reason: errors.join("; ") };
		if ((await harnessSnapshot(workspace)) === before) {
			const declared = /NO_CHANGE\s*[:\-—]?\s*(.*)/.exec(finalText)?.[1]?.trim();
			return { ...base, status: "no_change", reason: declared || "the proposer left the harness unchanged" };
		}
		const screened = await screenHarnessDir(workspace, { forbidden: o.forbidden });
		if (!screened.ok) return { ...base, status: "invalid", reason: screened.reason };
		await mkdir(o.outDir, { recursive: true });
		for (const entry of await readdir(workspace)) {
			if (HARNESS_FILES.includes(entry)) await cp(join(workspace, entry), join(o.outDir, entry));
		}
		await writeFile(
			join(o.outDir, "CHANGES.md"),
			`# Changes from ${o.parentDir}\n\n## Diagnosis\n${base.diagnosis}\n\n## Change manifest\n${base.manifest}\n`,
		);
		await writeFile(join(o.outDir, "PROPOSAL.md"), transcript);
		return { ...base, status: "edit" };
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}
