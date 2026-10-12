import { type CodemodeError, type CodemodeOutputItem, CodemodeSandbox } from "@earendil-works/pi-codemode";
import { clipMiddle } from "../util/text.ts";
import {
	type Budgets,
	type CapabilityDeps,
	createGlobals,
	MAX_LOG_EVENTS,
	newQuestionState,
	type QuestionState,
} from "./capabilities.ts";
import type { BudgetedTool, CapabilityName, TaskInfo, TraceEvent, Usage } from "./types.ts";
import { addUsage, emptyUsage } from "./usage.ts";

export type RunErrorKind = "script" | "timeout" | "aborted" | "sandbox" | "budget" | "no-answer";

export interface HarnessRun {
	answer: string | null;
	error?: { kind: RunErrorKind; message: string };
	trace: TraceEvent[];
	durationMs: number;
	calls: Record<BudgetedTool, number>;
	usage: Usage;
}

export interface RunHarnessOptions {
	source: string;
	prompt: string;
	task: TaskInfo;
	capabilities: readonly CapabilityName[];
	deps: CapabilityDeps;
	budgets: Budgets;
	signal?: AbortSignal;
	memoryLimitBytes?: number;
}

const DEFAULT_MEMORY_LIMIT = 256 * 1024 * 1024;

/** Wraps harness source into a codemode script body that calls solve(prompt) and returns a string or null. */
export function buildProgram(source: string, task: TaskInfo, prompt: string): string {
	const taskLiteral = JSON.stringify({ name: task.name, description: task.description });
	return [
		`const TASK = Object.freeze(${taskLiteral});${source}`,
		`;if (typeof solve !== "function") throw new Error("The harness must define async function solve(question).");`,
		`const __answer = await solve(${JSON.stringify(prompt)});`,
		"if (__answer === undefined || __answer === null) return null;",
		'return typeof __answer === "string" ? __answer : JSON.stringify(__answer);',
	].join("\n");
}

/** Runs one harness on one question in a fresh QuickJS VM. Never throws for harness failures. */
export async function runHarness(o: RunHarnessOptions): Promise<HarnessRun> {
	const state = newQuestionState();
	const sandbox = new CodemodeSandbox({
		globals: createGlobals(o.capabilities, o.deps, o.budgets, state),
		timeoutMs: o.budgets.questionTimeoutMs,
		memoryLimitBytes: o.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT,
	});
	try {
		const result = await sandbox.execute(buildProgram(o.source, o.task, o.prompt), { signal: o.signal });
		appendOutput(state, result.output);
		const base = {
			trace: [...state.trace],
			durationMs: Date.now() - state.startedAt,
			calls: { ...state.calls },
			usage: sumUsage(state.trace),
		};
		if (!result.ok) {
			const kind: RunErrorKind =
				state.budgetExceeded && result.error.kind === "script" ? "budget" : result.error.kind;
			return { ...base, answer: null, error: { kind, message: describeError(result.error) } };
		}
		if (result.value === null || result.value === undefined) {
			return { ...base, answer: null, error: { kind: "no-answer", message: "solve() returned no answer" } };
		}
		return { ...base, answer: String(result.value) };
	} finally {
		await sandbox.close();
	}
}

function describeError(error: CodemodeError): string {
	const head = error.name ? `${error.name}: ${error.message}` : error.message;
	if (!error.stack) return head;
	const frames = error.stack
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("at "))
		.slice(0, 4);
	return frames.length ? `${head}\n${frames.join("\n")}` : head;
}

function appendOutput(state: QuestionState, output: CodemodeOutputItem[]): void {
	const at = Date.now() - state.startedAt;
	for (const item of output) {
		if (item.type !== "text" || state.logEvents >= MAX_LOG_EVENTS) continue;
		state.logEvents++;
		state.trace.push({ tool: "log", at, durationMs: 0, input: clipMiddle(item.text, 2000), output: "" });
	}
}

function sumUsage(trace: readonly TraceEvent[]): Usage {
	const total = emptyUsage();
	for (const event of trace) if (event.usage) addUsage(total, event.usage);
	return total;
}
