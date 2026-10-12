import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { clip } from "../util/text.ts";

export interface ScreenOptions {
	maxLines: number;
	maxChars?: number;
	/** Development question texts that have appeared in reports shown to the proposer. */
	shownQuestions?: readonly string[];
	/** Expected answers that have appeared in reports shown to the proposer. */
	shownAnswers?: readonly string[];
}

export type ScreenResult = { ok: true } | { ok: false; reason: string };

const WINDOW = 48;
const STRIDE = 16;
const DEFAULT_MAX_CHARS = 60_000;

/** Static rejection before a candidate harness is executed (paper App. B.2 screens). */
export async function screenHarness(source: string, o: ScreenOptions): Promise<ScreenResult> {
	const maxChars = o.maxChars ?? DEFAULT_MAX_CHARS;
	if (source.length > maxChars) {
		return { ok: false, reason: `The harness has ${source.length} characters; the limit is ${maxChars}.` };
	}
	const lines = source.split("\n").length;
	if (lines > o.maxLines) {
		return { ok: false, reason: `The harness has ${lines} lines; the limit is ${o.maxLines}. Make it shorter.` };
	}
	const answer = findHardCodedAnswer(source, o.shownAnswers ?? []);
	if (answer !== undefined) {
		return {
			ok: false,
			reason: `The harness contains the expected answer ${JSON.stringify(clip(answer, 80))} of a development question. Do not hard-code answers: the harness is evaluated on unseen questions.`,
		};
	}
	if (containsQuestionSpecificText(source, o.shownQuestions ?? [])) {
		return {
			ok: false,
			reason:
				"The harness contains text copied from a specific development question. Do not special-case development questions: the harness is evaluated on unseen questions.",
		};
	}
	return await checkLoads(source);
}

/** Flags answers that are instance-specific (long, or containing digits or spaces) and appear verbatim. */
export function findHardCodedAnswer(source: string, answers: readonly string[]): string | undefined {
	for (const raw of answers) {
		const answer = raw.trim();
		const instanceSpecific = answer.length >= 24 || (answer.length >= 12 && /[\d\s]/.test(answer));
		if (instanceSpecific && source.includes(answer)) return answer;
	}
	return undefined;
}

/** True when the source contains a window of a question's text that no other shown question shares. */
export function containsQuestionSpecificText(source: string, questions: readonly string[]): boolean {
	for (let qi = 0; qi < questions.length; qi++) {
		const question = questions[qi];
		if (question.length < WINDOW) continue;
		for (let start = 0; start + WINDOW <= question.length; start += STRIDE) {
			const window = question.slice(start, start + WINDOW);
			if (!source.includes(window)) continue;
			const shared = questions.some((other, oi) => oi !== qi && other.includes(window));
			if (!shared) return true;
		}
	}
	return false;
}

async function checkLoads(source: string): Promise<ScreenResult> {
	const stub = (name: string): CodemodeTool => ({
		name,
		spread: true,
		execute: () => {
			throw new Error(`${name}() is not available while the harness is being validated`);
		},
	});
	const sandbox = new CodemodeSandbox({
		globals: [stub("llm"), stub("python"), stub("search"), stub("log")],
		timeoutMs: 5000,
		memoryLimitBytes: 128 * 1024 * 1024,
	});
	try {
		const program = `const TASK = Object.freeze({ name: "validation", description: "" });${source}\n;return typeof solve;`;
		const result = await sandbox.execute(program);
		if (!result.ok) {
			const name = result.error.name ? `${result.error.name}: ` : "";
			return { ok: false, reason: `The harness failed to load: ${name}${result.error.message}` };
		}
		if (result.value !== "function")
			return { ok: false, reason: "The harness must define async function solve(question)." };
		return { ok: true };
	} finally {
		await sandbox.close();
	}
}
