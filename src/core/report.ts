import { createTwoFilesPatch } from "diff";
import { clip, clipMiddle, fmt } from "../util/text.ts";
import {
	type EvalResult,
	OUTCOME_KINDS,
	type OutcomeKind,
	type Question,
	type QuestionOutcome,
	type Task,
	type TraceEvent,
} from "./types.ts";

export type RevisionStatus = "accepted" | "rejected" | "invalid" | "no_change";

export interface RevisionRecord {
	round: number;
	candidate: number;
	status: RevisionStatus;
	score: number | null;
	parentScore: number | null;
	summary: string;
}

export interface ReportOptions {
	task: Task;
	/** Feedback evaluation of the current harness. Must come from development questions only. */
	result: EvalResult;
	questions: readonly Question[];
	currentSource: string;
	previousSource?: string;
	history: readonly RevisionRecord[];
	maxFailures?: number;
	maxPasses?: number;
	questionChars?: number;
	eventChars?: number;
	maxEvents?: number;
	maxHistory?: number;
}

interface Settings {
	maxFailures: number;
	maxPasses: number;
	questionChars: number;
	eventChars: number;
	maxEvents: number;
	maxHistory: number;
}

const FAILURE_ORDER: readonly OutcomeKind[] = ["error", "timeout", "budget", "wrong", "partial"];

/** Execution report (paper App. E.2): scores, outcomes, failure traces, changes, revision history. */
export function buildReport(o: ReportOptions): string {
	const settings: Settings = {
		maxFailures: o.maxFailures ?? 8,
		maxPasses: o.maxPasses ?? 2,
		questionChars: o.questionChars ?? 1500,
		eventChars: o.eventChars ?? 700,
		maxEvents: o.maxEvents ?? 6,
		maxHistory: o.maxHistory ?? 20,
	};
	const byId = new Map(o.questions.map((q) => [q.id, q]));
	const r = o.result;
	const n = Math.max(r.outcomes.length, 1);
	const avgSeconds = r.outcomes.reduce((sum, x) => sum + x.durationMs, 0) / n / 1000;
	const counts = OUTCOME_KINDS.map((kind) => `${kind} ${r.counts[kind]}`).join(", ");
	const sections = [
		[
			"## Development results",
			`Score ${fmt(r.mean)} on ${r.outcomes.length} questions (${counts}).`,
			`Per question on average: ${fmt(r.calls.llm / n, 1)} solver calls, ${fmt(r.calls.python / n, 1)} python calls, ${fmt(r.calls.search / n, 1)} searches, ${fmt(avgSeconds, 1)} s.`,
		].join("\n"),
	];
	const failures = r.outcomes.filter((x) => x.kind !== "correct");
	const shown = pickDiverse(failures, settings.maxFailures);
	if (shown.length === 0) {
		sections.push("## Failed examples\nNone: every development question was answered correctly.");
	} else {
		sections.push(`## Failed examples (${shown.length} of ${failures.length})`);
		shown.forEach((x, i) => {
			sections.push(renderExample(`Failure ${i + 1}`, x, byId.get(x.questionId), o.task, settings, true));
		});
	}
	const passes = r.outcomes.filter((x) => x.kind === "correct").slice(0, settings.maxPasses);
	if (passes.length > 0) {
		sections.push(`## Passing examples (${passes.length} of ${r.counts.correct})`);
		passes.forEach((x, i) => {
			sections.push(renderExample(`Pass ${i + 1}`, x, byId.get(x.questionId), o.task, settings, false));
		});
	}
	if (o.previousSource !== undefined && o.previousSource !== o.currentSource) {
		sections.push(
			`## Changes since the previous retained harness\n\`\`\`diff\n${unifiedDiff(o.previousSource, o.currentSource)}\n\`\`\``,
		);
	}
	if (o.history.length > 0) sections.push(renderHistory(o.history.slice(-settings.maxHistory)));
	return sections.join("\n\n");
}

/** Up to n outcomes, round-robin over failure kinds so rare kinds are represented. */
export function pickDiverse(outcomes: readonly QuestionOutcome[], n: number): QuestionOutcome[] {
	const queues = FAILURE_ORDER.map((kind) => outcomes.filter((o) => o.kind === kind)).filter((q) => q.length > 0);
	const picked: QuestionOutcome[] = [];
	while (picked.length < n && queues.some((q) => q.length > 0)) {
		for (const queue of queues) {
			const next = queue.shift();
			if (next && picked.length < n) picked.push(next);
		}
	}
	return picked;
}

export function unifiedDiff(before: string, after: string): string {
	const patch = createTwoFilesPatch("previous/harness.js", "current/harness.js", before, after, "", "", {
		context: 3,
	});
	return patch
		.split("\n")
		.filter((line) => !line.startsWith("Index:") && !/^=+$/.test(line))
		.join("\n")
		.trim();
}

function renderExample(
	title: string,
	outcome: QuestionOutcome,
	question: Question | undefined,
	task: Task,
	settings: Settings,
	withTrace: boolean,
): string {
	const lines = [`### ${title}: ${outcome.kind}, score ${fmt(outcome.score)} (id ${outcome.questionId})`];
	if (question) {
		lines.push("Question:", "```", clipMiddle(question.prompt, settings.questionChars), "```");
		lines.push(`Expected answer: ${JSON.stringify(clip(question.answer, 500))}`);
	}
	lines.push(`Harness answer: ${outcome.answer === null ? "(none)" : JSON.stringify(clip(outcome.answer, 500))}`);
	if (outcome.gradeDetail) lines.push(`Grader: ${clip(outcome.gradeDetail, 300)}`);
	if (outcome.error) lines.push(`Error: ${clip(outcome.error, 800)}`);
	const extra = question ? task.describeOutcome?.(question, outcome) : undefined;
	if (extra) lines.push(extra);
	if (withTrace && outcome.trace.length > 0) {
		lines.push(`Trace (${outcome.trace.length} events, ${fmt(outcome.durationMs / 1000, 1)} s):`);
		lines.push(renderTrace(outcome.trace, settings));
	}
	return lines.join("\n");
}

function renderTrace(trace: readonly TraceEvent[], settings: Settings): string {
	const indices =
		trace.length <= settings.maxEvents
			? trace.map((_, i) => i)
			: [
					...Array.from({ length: Math.ceil(settings.maxEvents / 2) }, (_, i) => i),
					...Array.from(
						{ length: Math.floor(settings.maxEvents / 2) },
						(_, i) => trace.length - Math.floor(settings.maxEvents / 2) + i,
					),
				];
	const out: string[] = [];
	let previous = -1;
	for (const i of indices) {
		if (previous >= 0 && i > previous + 1) out.push(`- … ${i - previous - 1} events omitted …`);
		out.push(renderEvent(i, trace[i], settings.eventChars));
		previous = i;
	}
	return out.join("\n");
}

function renderEvent(index: number, event: TraceEvent, chars: number): string {
	const tokens = event.usage ? `, ${event.usage.input}→${event.usage.output} tokens` : "";
	const head = `- #${index + 1} ${event.tool} (${fmt(event.durationMs / 1000, 1)} s${tokens})${event.error ? ` [${event.error}]` : ""}`;
	const lines = [head, `  input: ${indent(clipMiddle(event.input, chars))}`];
	if (event.output) lines.push(`  output: ${indent(clipMiddle(event.output, chars))}`);
	return lines.join("\n");
}

function indent(text: string): string {
	return text.replace(/\n/g, "\n    ");
}

function renderHistory(history: readonly RevisionRecord[]): string {
	const rows = history.map((h) => {
		const score = h.score === null ? "–" : fmt(h.score);
		const parent = h.parentScore === null ? "–" : fmt(h.parentScore);
		const summary = clip(h.summary.replace(/\s+/g, " "), 240).replace(/\|/g, "\\|");
		return `| ${h.round} | ${h.candidate} | ${h.status} | ${score} | ${parent} | ${summary} |`;
	});
	return [
		"## Revision history",
		"| Round | Candidate | Status | Score | Parent score | Change |",
		"|---|---|---|---|---|---|",
		...rows,
	].join("\n");
}
