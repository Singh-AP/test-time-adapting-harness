import type { Question, Task } from "../core/types.ts";
import { createRng } from "../util/random.ts";

/** Offline task for tests and smoke runs: add two integers. */
export function createArithmeticTask(options: { dev?: number; heldout?: number; seed?: number } = {}): Task {
	const rng = createRng(options.seed ?? 7);
	const make = (split: string, n: number): Question[] =>
		Array.from({ length: n }, (_, i) => {
			const a = 100 + Math.floor(rng() * 9900);
			const b = 100 + Math.floor(rng() * 9900);
			return {
				id: `addition/${split}/${i}`,
				prompt: `What is ${a} + ${b}? Reply with the number only.`,
				answer: String(a + b),
			};
		});
	return {
		name: "toy:addition",
		description: "Add two integers. The answer is the integer only, with no other text.",
		capabilities: ["llm", "python"],
		dev: make("dev", options.dev ?? 10),
		heldout: make("heldout", options.heldout ?? 10),
		grade: async (question, answer) => ({ score: answer.trim() === question.answer ? 1 : 0 }),
	};
}
