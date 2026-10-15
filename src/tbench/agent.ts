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
import {
	type BashSettings,
	type DesignerSettings,
	formatDuration,
	type Harness,
	type ReviewSettings,
	renderTemplate,
} from "./harness.ts";
import { McpSseClient, mcpToolDefinitions } from "./mcp.ts";
import { type RemoteEnvironment, RemoteShell, remoteFileOperations, shellQuote } from "./remote.ts";

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
	/** Container directory with task-provided skills (one subdirectory with SKILL.md per skill). */
	skillsDir?: string;
	/** Task-provided MCP servers (Harbor's MCPServerConfig). */
	mcpServers?: McpServer[];
}

export interface McpServer {
	name: string;
	transport: string;
	url?: string | null;
	command?: string | null;
	args?: string[];
}

export interface ReviewRecord {
	round: number;
	verdict: "pass" | "fail" | "none";
	/** A review without a FAIL verdict counts as passing: there is nothing actionable to send back. */
	pass: boolean;
	issues: string;
	cost: number;
}

export interface TerminalAgentResult extends AgentUsage {
	stopReason: "completed" | "deadline" | "error";
	finishChecks: number;
	/** Replies cut off by the output limit that were continued. */
	lengthRecoveries: number;
	reviews: ReviewRecord[];
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

/** Lists task-provided skills (from each SKILL.md's front matter) and MCP servers for the first message. */
/**
 * Connects to task-provided MCP servers on the SSE transport. Their hosts are compose service names, resolved
 * inside the task container to container IPs the runner host can reach; the original Host header is kept.
 */
export async function connectMcpServers(shell: RemoteShell, servers: McpServer[]) {
	const tools: ToolDefinition<any, any, any>[] = [];
	const clients: McpSseClient[] = [];
	const notes = new Map<string, string>();
	const errors: string[] = [];
	for (const server of servers) {
		if (server.transport !== "sse" || !server.url) {
			notes.set(server.name, "not connected: only the SSE transport is supported by this agent");
			continue;
		}
		try {
			const url = new URL(server.url);
			const original = url.host;
			if (!/^[\d.]+$/.test(url.hostname) && url.hostname !== "localhost") {
				const lookup = await shell.run(
					`getent hosts ${shellQuote(url.hostname)} | awk '{print $1}' | head -n 1`,
					30,
				);
				const ip = lookup.output.trim();
				if (/^[\d.]+$/.test(ip)) url.hostname = ip;
			}
			const client = new McpSseClient(url.toString(), { hostHeader: original });
			const defs = await Promise.race([
				mcpToolDefinitions(server.name, client),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out listing tools")), 60_000)),
			]);
			clients.push(client);
			tools.push(...defs);
			notes.set(server.name, `connected; ${defs.length} tools available as mcp__${server.name}__*`);
		} catch (error) {
			errors.push(`MCP server ${server.name}: ${errorMessage(error)}`);
			notes.set(server.name, `could not be reached from the agent (${errorMessage(error)})`);
		}
	}
	return { tools, clients, notes, errors };
}

async function taskExtras(
	shell: RemoteShell,
	skillsDir: string | undefined,
	servers: McpServer[],
	mcpNotes: Map<string, string> = new Map(),
): Promise<string> {
	const parts: string[] = [];
	if (skillsDir) {
		const listing = await shell
			.run(
				`for f in ${shellQuote(skillsDir)}/*/SKILL.md; do [ -f "$f" ] && { echo "@@ $f"; head -n 15 "$f"; }; done`,
				60,
			)
			.catch(() => undefined);
		const skills = (listing?.output ?? "")
			.split("@@ ")
			.filter((block) => block.trim())
			.map((block) => {
				const [path, ...lines] = block.split("\n");
				const field = (key: string) =>
					lines
						.find((l) => l.toLowerCase().startsWith(`${key}:`))
						?.slice(key.length + 1)
						.trim();
				return `- ${field("name") ?? path.split("/").at(-2)}: ${field("description") ?? "(no description)"} (${path.trim()})`;
			});
		if (skills.length)
			parts.push(
				`Skills provided with this task (read a skill's SKILL.md fully before relying on it):\n${skills.join("\n")}`,
			);
	}
	if (servers.length)
		parts.push(
			`MCP servers provided with this task:\n${servers
				.map(
					(m) =>
						`- ${m.name}: ${m.transport} ${m.url ?? [m.command, ...(m.args ?? [])].join(" ")}${mcpNotes.has(m.name) ? ` (${mcpNotes.get(m.name)})` : ""}`,
				)
				.join("\n")}`,
		);
	return parts.join("\n\n");
}

/** Whether the last assistant message was cut off by the output limit. */
export function endsTruncated(s: { messages: readonly unknown[] }): boolean {
	const last = [...s.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
		| { stopReason?: string }
		| undefined;
	return last?.stopReason === "length";
}

export interface TruncatableSession {
	messages: readonly unknown[];
	prompt(text: string): Promise<void>;
	compact(): Promise<unknown>;
	getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
}

/**
 * Continues a session whose reply was cut off by the output limit (a runaway thought, or a context so full that
 * little output room remained), compacting first when the context is large. pi retries a truncated reply once per
 * run by itself; this covers the rest. Returns the number of continuations sent.
 */
export async function continueTruncated(
	s: TruncatableSession,
	o: { maxRecoveries: number; canContinue: () => boolean; continuePrompt: () => string; onError: (m: string) => void },
): Promise<number> {
	let n = 0;
	while (n < o.maxRecoveries && o.canContinue() && endsTruncated(s)) {
		n++;
		const usage = s.getContextUsage();
		if (usage?.tokens && usage.tokens > 0.7 * usage.contextWindow) {
			try {
				await s.compact();
			} catch (error) {
				o.onError(`compaction after a truncated reply failed: ${errorMessage(error)}`);
			}
		}
		await s.prompt(o.continuePrompt());
	}
	return n;
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

	const mcp = await connectMcpServers(shell, o.mcpServers ?? []);
	errors.push(...mcp.errors);
	const extras = await taskExtras(shell, o.skillsDir, o.mcpServers ?? [], mcp.notes);
	if (extras) environment = `${environment}\n\n${extras}`.trim();

	const files = remoteFileOperations(o.env);
	const read = createReadToolDefinition(cwd, { operations: files.read });
	const tools: ToolDefinition<any, any, any>[] = [
		bashTool(shell, cwd, h.bash),
		read,
		createEditToolDefinition(cwd, { operations: files.edit }),
		createWriteToolDefinition(cwd, { operations: files.write }),
		...mcp.tools,
	];
	const model = { ...o.model, contextWindow: Math.min(o.model.contextWindow, h.contextWindow) } as Model<Api>;
	const openSession = async (
		systemPrompt: string,
		sessionTools: ToolDefinition<any, any, any>[],
		thinkingLevel: Harness["thinkingLevel"] = h.thinkingLevel,
	) =>
		(
			await createAgentSession({
				cwd,
				agentDir: o.logsDir ? join(o.logsDir, ".pi") : undefined,
				modelRuntime: o.runtime,
				model,
				thinkingLevel: thinkingLevel === "off" ? undefined : thinkingLevel,
				noTools: "builtin",
				tools: sessionTools.map((t) => t.name),
				customTools: sessionTools,
				resourceLoader: resources(systemPrompt),
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager: SettingsManager.inMemory({
					compaction: h.compaction,
					retry: { enabled: true, maxRetries: 10, baseDelayMs: 2000, maxAgentDelayMs: 120_000 },
					httpIdleTimeoutMs: 600_000,
				}),
			})
		).session;
	const session = await openSession(h.systemPrompt, tools);
	/** The session the deadline aborts: the agent, or a reviewer while one runs. */
	let active = session;
	const reviewCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	let turns = 0;
	let toolCalls = 0;
	const usage = (): AgentUsage => {
		const stats = session.getSessionStats();
		return {
			turns,
			toolCalls,
			input: stats.tokens.input + reviewCost.input,
			output: stats.tokens.output + reviewCost.output,
			cacheRead: stats.tokens.cacheRead + reviewCost.cacheRead,
			cacheWrite: stats.tokens.cacheWrite + reviewCost.cacheWrite,
			cost: stats.cost + reviewCost.cost,
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
			void active.abort();
		},
		Math.max(0, deadline - Date.now()),
	);
	const warningTimers = h.timeWarnings
		.filter((f) => f > 0 && f < 1)
		.map((fraction) =>
			setTimeout(
				() => {
					if (stopReason !== "completed" || active !== session) return;
					void session
						.steer(
							`[harness] ${Math.round(fraction * 100)}% of the time budget is used; about ${formatDuration(remaining())} remain. Prioritize finishing and verifying the required outputs.`,
						)
						.catch(() => {});
				},
				Math.max(0, started + fraction * (deadline - started) - Date.now()),
			),
		);

	let lengthRecoveries = 0;
	/** session.prompt, then continue replies cut off by the output limit instead of ending the run. */
	const promptAgent = async (text: string) => {
		await session.prompt(text);
		lengthRecoveries += await continueTruncated(session, {
			maxRecoveries: h.maxLengthRecoveries - lengthRecoveries,
			canContinue: () => stopReason === "completed" && remaining() > 60,
			continuePrompt: () => renderTemplate(h.continuePrompt, { time_left: formatDuration(remaining()) }),
			onError: (message) => errors.push(message),
		});
	};

	const reviews: ReviewRecord[] = [];
	const review = async (round: number): Promise<ReviewRecord> => {
		const r = h.review as ReviewSettings;
		const reviewer = await openSession(r.prompt, [bashTool(shell, cwd, h.bash), read]);
		active = reviewer;
		const request = renderTemplate(r.request, {
			instruction: o.instruction,
			summary: session.getLastAssistantText() ?? "(no summary)",
			time_left: formatDuration(remaining()),
			predicted_checks: predictedChecks || "(none)",
		});
		try {
			await reviewer.prompt(request);
			if (endsTruncated(reviewer) && stopReason === "completed")
				await reviewer.prompt(
					"Your reply was cut off by the output length limit. Finish the review now: list the problems you found, then end with the verdict line.",
				);
		} finally {
			active = session;
		}
		const text = reviewer.getLastAssistantText() ?? "";
		const stats = reviewer.getSessionStats();
		reviewCost.input += stats.tokens.input;
		reviewCost.output += stats.tokens.output;
		reviewCost.cacheRead += stats.tokens.cacheRead;
		reviewCost.cacheWrite += stats.tokens.cacheWrite;
		reviewCost.cost += stats.cost;
		if (o.logsDir) {
			await mkdir(o.logsDir, { recursive: true });
			await writeFile(join(o.logsDir, `review-${round}.md`), `${renderTranscript(reviewer.messages)}\n`);
		}
		reviewer.dispose();
		const verdict = /VERDICT:\s*(PASS|FAIL)/i.exec(text)?.[1]?.toUpperCase();
		const failAt = text.search(/VERDICT:\s*FAIL/i);
		let issues =
			verdict === "FAIL"
				? text
						.slice(failAt)
						.replace(/VERDICT:\s*FAIL\s*/i, "")
						.trim()
				: "";
		// Reviewers often list the problems first and end with the verdict line.
		if (verdict === "FAIL" && !issues) issues = text.slice(0, failAt).trim();
		return {
			round,
			verdict: verdict === "PASS" ? "pass" : verdict === "FAIL" ? "fail" : "none",
			pass: verdict !== "FAIL",
			issues,
			cost: stats.cost,
		};
	};

	let predictedChecks = "";
	const design = async () => {
		const d = h.designer as DesignerSettings;
		const designer = await openSession(d.prompt, [bashTool(shell, cwd, h.bash), read], d.thinkingLevel);
		active = designer;
		// Ask for the answer well before the limit; a turn in progress finishes first, so allow a grace period.
		const limitMs = Math.min(d.timeoutSec, remaining() / 4) * 1000;
		const wrapUp = setTimeout(
			() =>
				void designer
					.steer("Time is up: stop investigating and reply now with your numbered list of checks.")
					.catch(() => {}),
			limitMs * 0.6,
		);
		const stop = setTimeout(() => void designer.abort(), limitMs + 180_000);
		try {
			await designer.prompt(
				renderTemplate(d.request, { instruction: o.instruction, environment: environment || "(no snapshot)" }),
			);
			if (!/^\s*1[.)]/m.test(designer.getLastAssistantText() ?? ""))
				await designer.prompt("Reply now with your numbered list of checks only.");
		} catch (error) {
			errors.push(`test designer failed: ${errorMessage(error)}`);
		} finally {
			clearTimeout(wrapUp);
			clearTimeout(stop);
			active = session;
		}
		predictedChecks = clip((designer.getLastAssistantText() ?? "").trim(), 8000);
		const stats = designer.getSessionStats();
		reviewCost.input += stats.tokens.input;
		reviewCost.output += stats.tokens.output;
		reviewCost.cacheRead += stats.tokens.cacheRead;
		reviewCost.cacheWrite += stats.tokens.cacheWrite;
		reviewCost.cost += stats.cost;
		if (o.logsDir) {
			await mkdir(o.logsDir, { recursive: true });
			await writeFile(join(o.logsDir, "designer.md"), `${renderTranscript(designer.messages)}\n`);
		}
		designer.dispose();
	};

	let finishChecks = 0;
	try {
		if (h.designer && remaining() > 300) await design();
		const firstMessage = renderTemplate(h.userPrompt, {
			instruction: o.instruction,
			environment: environment || "(no environment snapshot)",
			time_budget: formatDuration(remaining()),
		});
		await promptAgent(
			predictedChecks && h.designer
				? `${firstMessage}\n\n${renderTemplate(h.designer.handoff, { checks: predictedChecks })}`
				: firstMessage,
		);
		while (stopReason === "completed" && h.finishCheck && finishChecks < h.maxFinishChecks && remaining() > 60) {
			finishChecks++;
			await promptAgent(renderTemplate(h.finishCheck, { time_left: formatDuration(remaining()) }));
		}
		for (let round = 1; h.review && round <= h.review.maxRounds; round++) {
			if (stopReason !== "completed" || remaining() < Math.max(60, h.review.minTimeLeftSec)) break;
			const record = await review(round);
			reviews.push(record);
			if (record.pass || stopReason !== "completed") break;
			await promptAgent(
				renderTemplate(h.review.followup, { issues: record.issues, time_left: formatDuration(remaining()) }),
			);
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
		lengthRecoveries,
		reviews,
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
	for (const client of mcp.clients) client.close();
	return result;
}
