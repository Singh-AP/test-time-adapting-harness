import { mapLimit } from "../util/concurrency.ts";
import { hashSource } from "../util/hash.ts";
import { errorMessage } from "../util/text.ts";
import type { Budgets, CapabilityDeps } from "./capabilities.ts";
import { type HarnessRun, runHarness } from "./sandbox.ts";
import {
	type EvalResult,
	OUTCOME_KINDS,
	type OutcomeKind,
	type Question,
	type QuestionOutcome,
	type Task,
} from "./types.ts";
import { addUsage, emptyUsage } from "./usage.ts";

export interface EvaluateOptions {
	task: Task;
	source: string;
	questions: readonly Question[];
	label: string;
	deps: CapabilityDeps;
	budgets: Budgets;
	concurrency: number;
	signal?: AbortSignal;
	onOutcome?: (outcome: QuestionOutcome, done: number, total: number) => void;
}

export function classifyOutcome(run: Pick<HarnessRun, "error">, score: number): OutcomeKind {
	if (run.error) {
		if (run.error.kind === "timeout") return "timeout";
		if (run.error.kind === "budget") return "budget";
		return "error";
	}
	if (score >= 1 - 1e-9) return "correct";
	if (score > 0) return "partial";
	return "wrong";
}

/** J(h; Q): runs the harness on every question and grades the answers. */
export async function evaluateHarness(o: EvaluateOptions): Promise<EvalResult> {
	const started = Date.now();
	const info = { name: o.task.name, description: o.task.description };
	let done = 0;
	const outcomes = await mapLimit(o.questions, o.concurrency, async (question): Promise<QuestionOutcome> => {
		const run = await runHarness({
			source: o.source,
			prompt: question.prompt,
			task: info,
			capabilities: o.task.capabilities,
			deps: o.deps,
			budgets: o.budgets,
			signal: o.signal,
		});
		let score = 0;
		let gradeDetail: string | undefined;
		if (run.answer !== null) {
			try {
				const grade = await o.task.grade(question, run.answer);
				score = Number.isFinite(grade.score) ? Math.min(Math.max(grade.score, 0), 1) : 0;
				gradeDetail = grade.detail;
			} catch (error) {
				gradeDetail = `grader error: ${errorMessage(error)}`;
			}
		}
		const outcome: QuestionOutcome = {
			questionId: question.id,
			answer: run.answer,
			score,
			kind: classifyOutcome(run, score),
			error: run.error?.message,
			gradeDetail,
			trace: run.trace,
			durationMs: run.durationMs,
			calls: run.calls,
			usage: run.usage,
		};
		done++;
		o.onOutcome?.(outcome, done, o.questions.length);
		return outcome;
	});
	return summarizeOutcomes(o.label, hashSource(o.source), outcomes, Date.now() - started);
}

export function summarizeOutcomes(
	label: string,
	harnessHash: string,
	outcomes: QuestionOutcome[],
	durationMs: number,
): EvalResult {
	const counts = Object.fromEntries(OUTCOME_KINDS.map((kind) => [kind, 0])) as Record<OutcomeKind, number>;
	const calls = { llm: 0, python: 0, search: 0 };
	const usage = emptyUsage();
	let total = 0;
	for (const outcome of outcomes) {
		counts[outcome.kind]++;
		total += outcome.score;
		calls.llm += outcome.calls.llm;
		calls.python += outcome.calls.python;
		calls.search += outcome.calls.search;
		addUsage(usage, outcome.usage);
	}
	const n = outcomes.length;
	const completed = n - counts.error - counts.timeout - counts.budget;
	return {
		label,
		harnessHash,
		mean: n ? total / n : 0,
		counts,
		completedFraction: n ? completed / n : 0,
		outcomes,
		calls,
		usage,
		durationMs,
	};
}
