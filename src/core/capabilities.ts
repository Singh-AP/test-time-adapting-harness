import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { clipMiddle, errorMessage } from "../util/text.ts";
import type {
	BudgetedTool,
	CapabilityName,
	PythonResult,
	PythonRunner,
	SearchBackend,
	SolverClient,
	SolverMessage,
	SolverRequest,
	TraceEvent,
} from "./types.ts";

export interface CapabilityDeps {
	solver: SolverClient;
	python?: PythonRunner;
	search?: SearchBackend;
}

export interface Budgets {
	/** Solver calls per question. */
	llmCalls: number;
	pythonCalls: number;
	searchCalls: number;
	/** Wall-clock limit per question, including time spent in calls. */
	questionTimeoutMs: number;
	/** Upper bound on maxTokens for one solver call. */
	maxTokensPerCall: number;
	/** Upper bound on one python() call. */
	pythonTimeoutMs: number;
	/** Upper bound on k for one search() call. */
	searchMaxK: number;
}

export const DEFAULT_BUDGETS: Budgets = {
	llmCalls: 12,
	pythonCalls: 12,
	searchCalls: 12,
	questionTimeoutMs: 300_000,
	maxTokensPerCall: 4096,
	pythonTimeoutMs: 20_000,
	searchMaxK: 20,
};

/** Mutable per-question state shared by the injected globals. */
export interface QuestionState {
	startedAt: number;
	trace: TraceEvent[];
	calls: Record<BudgetedTool, number>;
	budgetExceeded: boolean;
	logEvents: number;
}

export function newQuestionState(): QuestionState {
	return {
		startedAt: Date.now(),
		trace: [],
		calls: { llm: 0, python: 0, search: 0 },
		budgetExceeded: false,
		logEvents: 0,
	};
}

export const TRACE_CHARS = 4000;
export const MAX_LOG_EVENTS = 200;

/** Validates what a harness passed to llm() and converts it to a SolverRequest. */
export function normalizeSolverRequest(arg: unknown, maxTokensCap: number): SolverRequest {
	if (typeof arg === "string")
		return { messages: [{ role: "user", content: nonEmpty(arg) }], maxTokens: maxTokensCap };
	if (arg === null || typeof arg !== "object" || Array.isArray(arg)) {
		throw new TypeError(
			"llm() expects a prompt string or an object {system, prompt, messages, temperature, maxTokens}",
		);
	}
	const r = arg as Record<string, unknown>;
	const raw: SolverMessage[] = [];
	if (r.messages !== undefined) {
		if (!Array.isArray(r.messages)) throw new TypeError("llm(): messages must be an array of {role, content}");
		for (const m of r.messages) {
			const { role, content } = (m ?? {}) as Record<string, unknown>;
			if (role !== "user" && role !== "assistant") {
				throw new TypeError(`llm(): message role must be "user" or "assistant", got ${JSON.stringify(role)}`);
			}
			if (typeof content !== "string") throw new TypeError("llm(): message content must be a string");
			raw.push({ role, content });
		}
	}
	if (r.prompt !== undefined) {
		if (typeof r.prompt !== "string") throw new TypeError("llm(): prompt must be a string");
		raw.push({ role: "user", content: r.prompt });
	}
	if (raw.length === 0) throw new TypeError("llm(): provide prompt or messages");
	const messages = mergeConsecutive(raw);
	if (messages[0].role !== "user") throw new TypeError('llm(): the first message must have role "user"');
	if (messages[messages.length - 1].role !== "user") {
		throw new TypeError('llm(): the last message must have role "user"');
	}
	if (r.system !== undefined && typeof r.system !== "string") throw new TypeError("llm(): system must be a string");
	const request: SolverRequest = { messages, maxTokens: maxTokensCap };
	if (typeof r.system === "string" && r.system.length > 0) request.system = r.system;
	if (typeof r.temperature === "number" && Number.isFinite(r.temperature)) {
		request.temperature = Math.min(Math.max(r.temperature, 0), 1.5);
	}
	if (typeof r.maxTokens === "number" && Number.isFinite(r.maxTokens)) {
		request.maxTokens = Math.max(16, Math.min(Math.floor(r.maxTokens), maxTokensCap));
	}
	return request;
}

function nonEmpty(text: string): string {
	return text.length > 0 ? text : "(empty)";
}

function mergeConsecutive(messages: SolverMessage[]): SolverMessage[] {
	const out: SolverMessage[] = [];
	for (const m of messages) {
		const content = nonEmpty(m.content);
		const last = out[out.length - 1];
		if (last && last.role === m.role) last.content = `${last.content}\n\n${content}`;
		else out.push({ role: m.role, content });
	}
	return out;
}

function renderRequest(request: SolverRequest): string {
	const parts: string[] = [];
	if (request.system) parts.push(`[system] ${request.system}`);
	for (const m of request.messages) parts.push(`[${m.role}] ${m.content}`);
	return parts.join("\n");
}

function renderPython(result: PythonResult): string {
	const parts = [result.stdout.length ? `stdout:\n${result.stdout}` : "stdout: (empty)"];
	if (result.stderr.length) parts.push(`stderr:\n${result.stderr}`);
	return parts.join("\n");
}

function stringifyLog(values: unknown[]): string {
	return values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
}

/** Builds the codemode globals a harness can call for one question. */
export function createGlobals(
	capabilities: readonly CapabilityName[],
	deps: CapabilityDeps,
	budgets: Budgets,
	state: QuestionState,
): CodemodeTool[] {
	const globals: CodemodeTool[] = [];
	const elapsed = () => Date.now() - state.startedAt;
	const charge = (tool: BudgetedTool, limit: number) => {
		if (state.calls[tool] >= limit) {
			state.budgetExceeded = true;
			throw new Error(`${tool}() budget exhausted: at most ${limit} calls per question`);
		}
		state.calls[tool]++;
	};

	if (capabilities.includes("llm")) {
		globals.push({
			name: "llm",
			description: "Call the fixed solver model and return its text output.",
			signature:
				'(request: string | { system?: string; prompt?: string; messages?: { role: "user" | "assistant"; content: string }[]; temperature?: number; maxTokens?: number }): Promise<string>',
			execute: async (arg, { signal }) => {
				const request = normalizeSolverRequest(arg, budgets.maxTokensPerCall);
				charge("llm", budgets.llmCalls);
				const at = elapsed();
				const input = clipMiddle(renderRequest(request), TRACE_CHARS);
				const started = Date.now();
				try {
					const response = await deps.solver.complete(request, signal);
					state.trace.push({
						tool: "llm",
						at,
						durationMs: Date.now() - started,
						input,
						output: clipMiddle(response.text, TRACE_CHARS),
						usage: response.usage,
						...(response.stopReason === "length" ? { error: "output truncated at maxTokens" } : {}),
					});
					return response.text;
				} catch (error) {
					state.trace.push({
						tool: "llm",
						at,
						durationMs: Date.now() - started,
						input,
						output: "",
						error: errorMessage(error),
					});
					throw error;
				}
			},
		});
	}

	if (capabilities.includes("python")) {
		const runner = deps.python;
		if (!runner) throw new Error("This task enables python(), but no PythonRunner was configured");
		globals.push({
			name: "python",
			spread: true,
			description: "Run Python 3 code in an isolated subprocess and return its output.",
			signature:
				"(code: string, options?: { timeoutMs?: number; stdin?: string }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>",
			execute: async (args, { signal }) => {
				const [code, options] = args as [unknown, unknown];
				if (typeof code !== "string") throw new TypeError("python(code) expects Python source as a string");
				const opts = (options ?? {}) as Record<string, unknown>;
				const timeoutMs =
					typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
						? Math.max(100, Math.min(opts.timeoutMs, budgets.pythonTimeoutMs))
						: budgets.pythonTimeoutMs;
				const stdin = typeof opts.stdin === "string" ? opts.stdin : undefined;
				charge("python", budgets.pythonCalls);
				const at = elapsed();
				const started = Date.now();
				const input = clipMiddle(code, TRACE_CHARS);
				try {
					const result = await runner.run(code, { timeoutMs, stdin, signal });
					const error = result.timedOut
						? `timed out after ${timeoutMs} ms`
						: result.exitCode !== 0
							? `exit code ${result.exitCode}`
							: undefined;
					state.trace.push({
						tool: "python",
						at,
						durationMs: Date.now() - started,
						input,
						output: clipMiddle(renderPython(result), TRACE_CHARS),
						...(error ? { error } : {}),
					});
					return result;
				} catch (error) {
					state.trace.push({
						tool: "python",
						at,
						durationMs: Date.now() - started,
						input,
						output: "",
						error: errorMessage(error),
					});
					throw error;
				}
			},
		});
	}

	if (capabilities.includes("search")) {
		const backend = deps.search;
		if (!backend) throw new Error("This task enables search(), but no SearchBackend was configured");
		globals.push({
			name: "search",
			spread: true,
			description: "Retrieve passages from the task corpus.",
			signature: "(query: string, k?: number): Promise<{ id: string; title: string; text: string }[]>",
			execute: async (args) => {
				const [query, k] = args as [unknown, unknown];
				if (typeof query !== "string") throw new TypeError("search(query, k) expects the query as a string");
				const limit =
					typeof k === "number" && Number.isFinite(k)
						? Math.max(1, Math.min(Math.floor(k), budgets.searchMaxK))
						: 5;
				charge("search", budgets.searchCalls);
				const at = elapsed();
				const started = Date.now();
				try {
					const passages = await backend.search(query, limit);
					state.trace.push({
						tool: "search",
						at,
						durationMs: Date.now() - started,
						input: clipMiddle(`${query} (k=${limit})`, TRACE_CHARS),
						output: clipMiddle(passages.map((p) => p.title).join(" | "), TRACE_CHARS),
					});
					return passages;
				} catch (error) {
					state.trace.push({
						tool: "search",
						at,
						durationMs: Date.now() - started,
						input: query,
						output: "",
						error: errorMessage(error),
					});
					throw error;
				}
			},
		});
	}

	globals.push({
		name: "log",
		spread: true,
		description: "Record a note in the execution trace.",
		signature: "(...values: unknown[]): void",
		execute: (args) => {
			if (state.logEvents < MAX_LOG_EVENTS) {
				state.logEvents++;
				state.trace.push({
					tool: "log",
					at: elapsed(),
					durationMs: 0,
					input: clipMiddle(stringifyLog(args as unknown[]), 2000),
					output: "",
				});
			}
			return null;
		},
	});

	return globals;
}
