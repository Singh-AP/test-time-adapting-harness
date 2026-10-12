import type { Budgets } from "./capabilities.ts";
import type { CapabilityName, TaskInfo } from "./types.ts";

/** Documentation of the harness runtime shown to proposers. */
export function harnessApiDoc(capabilities: readonly CapabilityName[], budgets: Budgets): string {
	const lines = [
		"Harness API. The harness is plain JavaScript (ES2023) that runs in a sandbox. It must define `async function solve(question)` that returns the final answer as a string. These globals are its only I/O:",
		"- `TASK`: frozen object {name, description}.",
	];
	if (capabilities.includes("llm")) {
		lines.push(
			`- \`await llm(request)\` returns a string. \`request\` is a prompt string or {system?, prompt?, messages?: [{role: "user" | "assistant", content}], temperature? (0 to 1.5), maxTokens? (at most ${budgets.maxTokensPerCall})}. It calls the fixed solver model and returns its text. A conversation must start and end with a user message. Budget: ${budgets.llmCalls} calls per question.`,
		);
	}
	if (capabilities.includes("python")) {
		lines.push(
			`- \`await python(code, {timeoutMs?, stdin?})\` returns {stdout, stderr, exitCode, timedOut}. It runs Python 3.12 (standard library, numpy, sympy) in an isolated process with no network and no file access outside a scratch directory. Print results to stdout. Budget: ${budgets.pythonCalls} calls per question, at most ${budgets.pythonTimeoutMs} ms each.`,
		);
	}
	if (capabilities.includes("search")) {
		lines.push(
			`- \`await search(query, k = 5)\` returns [{id, title, text}] by BM25 retrieval over the task corpus (k at most ${budgets.searchMaxK}). Budget: ${budgets.searchCalls} calls per question.`,
		);
	}
	lines.push(
		"- `log(...values)` records a note in the execution trace shown in later reports. `console.log` also records notes.",
		`Each question runs in a fresh sandbox with a ${Math.round(budgets.questionTimeoutMs / 1000)} s limit that includes all calls. Independent calls can run concurrently with Promise.all. There is no require or import, fetch, filesystem, process, or timers, and no state persists between questions.`,
	);
	return lines.join("\n");
}

export function proposerSystemPrompt(o: {
	capabilities: readonly CapabilityName[];
	budgets: Budgets;
	maxLines: number;
}): string {
	return `You are an expert harness engineer. A harness is a JavaScript program that answers the questions of one task by organizing calls to a fixed solver language model, tool use, and direct computation. You cannot change the solver model. You can change everything around it: prompts, the number and order of solver calls, answer parsing and normalization, verification and retries, voting, code execution, retrieval, and direct algorithmic computation in JavaScript.

You receive the task description, the current harness with its development score, and an execution report from running it on development questions. Diagnose the observed failures, then make a targeted revision that should raise the score on new, unseen questions of the same task.

Rules:
- Keep the entry point \`async function solve(question)\`. It must return the final answer as a string in exactly the format the task expects.
- Do not hard-code answers or special-case particular development questions. Do not copy text from development questions or their expected answers into the harness, not even as examples in prompts; write your own made-up examples. The revised harness is evaluated on unseen questions.
- Stay within the per-question budgets. Calls beyond a budget throw an error.
- Keep the harness under ${o.maxLines} lines.

${harnessApiDoc(o.capabilities, o.budgets)}

Respond in this format:
## Diagnosis
What fails and why, citing the report.
## Edits
One or more SEARCH/REPLACE blocks against the current harness:
<<<<<<< SEARCH
exact lines copied from the current harness
=======
replacement lines
>>>>>>> REPLACE
SEARCH text must match the current harness exactly, including indentation, and occur once. An empty SEARCH section appends to the end of the file. For a complete rewrite, put the whole new harness in a single \`\`\`js code block instead of SEARCH/REPLACE blocks.
## Change manifest
One paragraph: what changed, which failures it should fix, and likely regressions.

If no change would help, reply with a single line \`NO_CHANGE: <reason>\` instead.`;
}

export function revisionPrompt(o: {
	task: TaskInfo;
	source: string;
	score: number;
	feedbackSize: number;
	report: string;
	branch?: { index: number; total: number };
	/** Task-agnostic lessons distilled from adaptations on other tasks. */
	playbook?: string;
}): string {
	const parts = [
		`# Task\nName: ${o.task.name}\n${o.task.description}`,
		`# Current harness (development score ${o.score.toFixed(3)} on ${o.feedbackSize} questions)\n\`\`\`js\n${o.source.replace(/\n$/, "")}\n\`\`\``,
		`# Execution report\n${o.report}`,
	];
	if (o.playbook) parts.push(`# Lessons from previous adaptations (other tasks)\n${o.playbook.trim()}`);
	if (o.branch) {
		parts.push(
			`# Branch\nYou are proposal ${o.branch.index + 1} of ${o.branch.total} sampled independently from this same report. To keep proposals diverse, rank the promising changes yourself and pursue option number ${o.branch.index + 1}, or a distinct variation if you see fewer options.`,
		);
	}
	parts.push(
		"Propose a targeted revision as SEARCH/REPLACE edits against the current source. Explain the change and identify the failures it is expected to fix and any likely regressions.",
	);
	return parts.join("\n\n");
}

export function retryPrompt(error: string): string {
	return `Your previous response could not be used: ${error}\nThe current harness is unchanged. Reply again in the required format, with SEARCH text copied exactly from the current harness shown above.`;
}
