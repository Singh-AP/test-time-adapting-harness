import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
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
import { clip, errorMessage } from "../util/text.ts";
import { type BashSettings, formatDuration, type Harness, renderTemplate } from "./harness.ts";
import { type RemoteEnvironment, RemoteShell, remoteFileOperations } from "./remote.ts";

export interface AgentUsage {
	turns: number;
	toolCalls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface TerminalAgentOptions {
	instruction: string;
	env: RemoteEnvironment;
	runtime: ModelRuntime;
	model: Model<Api>;
	harness: Harness;
	/** Wall-clock budget for the whole run. */
	timeBudgetSec: number;
	/** Seconds kept in reserve before the budget ends (default 5% of the budget, at most 10 minutes). */
	safetyMarginSec?: number;
	/** Container working directory; default: the container's `pwd`. */
	cwd?: string;
	/** Local directory for the transcript, session JSONL and result. */
	logsDir?: string;
	onUsage?: (usage: AgentUsage) => void;
}

export interface TerminalAgentResult extends AgentUsage {
	stopReason: "completed" | "deadline" | "error";
	finishChecks: number;
	finalText: string;
	errors: string[];
	elapsedSec: number;
}

function resources(systemPrompt: string): ResourceLoader {
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

function bashTool(shell: RemoteShell, cwd: string, s: BashSettings): ToolDefinition<any, any, any> {
	return defineTool({
		name: "bash",
		label: "Bash",
		description: `Run a bash command in the task container (working directory ${cwd}). Every call starts a fresh shell: cd, exports and shell variables do not persist between calls, but files and background processes do. Stdin is /dev/null, so commands must not wait for input; use non-interactive flags. Output (stdout and stderr together) is capped to the first ${s.headBytes} and last ${s.tailBytes} bytes; the full output is kept in a log file in the container. Default timeout ${s.defaultTimeoutSec}s, maximum ${s.maxTimeoutSec}s; for longer jobs start them in the background (nohup cmd > /tmp/job.log 2>&1 &) and poll the log.`,
		parameters: Type.Object({
			command: Type.String({ description: "Bash command or script to run" }),
			timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (default ${s.defaultTimeoutSec})` })),
		}),
		execute: async (_id, params) => {
			const p = params as { command: string; timeout?: number };
			const requested = Number.isFinite(p.timeout) && (p.timeout ?? 0) > 0 ? Number(p.timeout) : s.defaultTimeoutSec;
			const timeout = Math.min(requested, s.maxTimeoutSec);
			const r = await shell.run(p.command, timeout);
			let text = r.output.length > 0 ? r.output : "(no output)";
			if (r.timedOut)
				text += `\n\n[Command timed out after ${timeout}s and was killed. Run long jobs in the background and poll.]`;
			else if (r.exitCode !== 0) text += `\n\n[exit code ${r.exitCode}]`;
			return {
				content: [{ type: "text", text }],
				details: { exitCode: r.exitCode, timedOut: r.timedOut, elapsedSec: r.elapsedSec, logPath: r.logPath },
				isError: r.timedOut || r.exitCode !== 0,
			};
		},
	});
}

function messageText(message: unknown): string {
	const m = message as { content?: unknown };
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return (m.content as Record<string, unknown>[])
		.map((b) => {
			if (b.type === "text") return String(b.text ?? "");
			if (b.type === "thinking") return `[thinking] ${clip(String(b.thinking ?? ""), 2000)}`;
			if (b.type === "toolCall")
				return `[tool call] ${String(b.name)} ${clip(JSON.stringify(b.arguments ?? {}), 4000)}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Markdown transcript of a session for humans and for the adaptation loop's reports. */
export function renderTranscript(messages: readonly unknown[]): string {
	return messages
		.map((raw) => {
			const m = raw as { role?: string; toolName?: string; isError?: boolean };
			if (m.role === "user") return `## user\n${messageText(m)}`;
			if (m.role === "assistant") return `## assistant\n${messageText(m)}`;
			if (m.role === "toolResult")
				return `## tool result: ${m.toolName}${m.isError ? " (error)" : ""}\n${clip(messageText(m), 6000)}`;
			if (m.role === "compactionSummary" || m.role === "summary") return `## compaction summary\n${messageText(m)}`;
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

/** Runs one Terminal-Bench task: the pi agent on the host, its tools in the task container. */
export async function runTerminalAgent(o: TerminalAgentOptions): Promise<TerminalAgentResult> {
	const started = Date.now();
	const h = o.harness;
	const errors: string[] = [];
	const margin = o.safetyMarginSec ?? Math.min(600, o.timeBudgetSec * 0.05);
	const deadline = started + Math.max(0, o.timeBudgetSec - margin) * 1000;
	const remaining = () => Math.max(0, (deadline - Date.now()) / 1000);

	let cwd = o.cwd;
	if (!cwd) {
		const pwd = await o.env.exec("pwd", 30).catch(() => undefined);
		cwd = pwd?.stdout.trim() || "/";
	}
	const shell = new RemoteShell(o.env, {
		cwd,
		headBytes: h.bash.headBytes,
		tailBytes: h.bash.tailBytes,
	});
	let environment = "";
	if (h.probe) {
		try {
			const probe = await shell.run(h.probe, 120);
			environment = clip(probe.output.trim(), 8000);
		} catch (error) {
			errors.push(`probe failed: ${errorMessage(error)}`);
		}
	}

	const files = remoteFileOperations(o.env);
	const tools: ToolDefinition<any, any, any>[] = [
		bashTool(shell, cwd, h.bash),
		createReadToolDefinition(cwd, { operations: files.read }),
		createEditToolDefinition(cwd, { operations: files.edit }),
		createWriteToolDefinition(cwd, { operations: files.write }),
	];
	const model = { ...o.model, contextWindow: Math.min(o.model.contextWindow, h.contextWindow) } as Model<Api>;
	const { session } = await createAgentSession({
		cwd,
		agentDir: o.logsDir ? join(o.logsDir, ".pi") : undefined,
		modelRuntime: o.runtime,
		model,
		thinkingLevel: h.thinkingLevel === "off" ? undefined : h.thinkingLevel,
		noTools: "builtin",
		tools: tools.map((t) => t.name),
		customTools: tools,
		resourceLoader: resources(h.systemPrompt),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({
			compaction: h.compaction,
			retry: { enabled: true, maxRetries: 10, baseDelayMs: 2000, maxAgentDelayMs: 120_000 },
		}),
	});

	let turns = 0;
	let toolCalls = 0;
	const usage = (): AgentUsage => {
		const stats = session.getSessionStats();
		return {
			turns,
			toolCalls,
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			cost: stats.cost,
		};
	};
	let lastSave = 0;
	const saveTranscript = () => {
		if (!o.logsDir || Date.now() - lastSave < 20_000) return;
		lastSave = Date.now();
		const logsDir = o.logsDir;
		void mkdir(logsDir, { recursive: true })
			.then(() => writeFile(join(logsDir, "transcript.md"), `${renderTranscript(session.messages)}\n`))
			.catch(() => {});
	};
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "turn_end") {
			turns++;
			o.onUsage?.(usage());
			saveTranscript();
		} else if (event.type === "tool_execution_end") toolCalls++;
	});

	let stopReason: TerminalAgentResult["stopReason"] = "completed";
	const deadlineTimer = setTimeout(
		() => {
			stopReason = "deadline";
			void session.abort();
		},
		Math.max(0, deadline - Date.now()),
	);
	const warningTimers = h.timeWarnings
		.filter((f) => f > 0 && f < 1)
		.map((fraction) =>
			setTimeout(
				() => {
					if (stopReason !== "completed") return;
					void session
						.steer(
							`[harness] ${Math.round(fraction * 100)}% of the time budget is used; about ${formatDuration(remaining())} remain. Prioritize finishing and verifying the required outputs.`,
						)
						.catch(() => {});
				},
				Math.max(0, started + fraction * (deadline - started) - Date.now()),
			),
		);

	let finishChecks = 0;
	try {
		await session.prompt(
			renderTemplate(h.userPrompt, {
				instruction: o.instruction,
				environment: environment || "(no environment snapshot)",
				time_budget: formatDuration(remaining()),
			}),
		);
		while (stopReason === "completed" && h.finishCheck && finishChecks < h.maxFinishChecks && remaining() > 60) {
			finishChecks++;
			await session.prompt(renderTemplate(h.finishCheck, { time_left: formatDuration(remaining()) }));
		}
	} catch (error) {
		if (stopReason === "completed") {
			stopReason = "error";
			errors.push(`agent session error: ${errorMessage(error)}`);
		}
	} finally {
		clearTimeout(deadlineTimer);
		for (const t of warningTimers) clearTimeout(t);
	}
	const result: TerminalAgentResult = {
		...usage(),
		stopReason,
		finishChecks,
		finalText: session.getLastAssistantText() ?? "",
		errors,
		elapsedSec: (Date.now() - started) / 1000,
	};
	unsubscribe();
	if (o.logsDir) {
		await mkdir(o.logsDir, { recursive: true });
		await writeFile(join(o.logsDir, "transcript.md"), `${renderTranscript(session.messages)}\n`);
		await writeFile(join(o.logsDir, "agent-result.json"), `${JSON.stringify(result, null, 2)}\n`);
		try {
			session.exportToJsonl(join(o.logsDir, "session.jsonl"));
		} catch (error) {
			errors.push(`session export failed: ${errorMessage(error)}`);
		}
	}
	session.dispose();
	return result;
}
