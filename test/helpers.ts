import type {
	ProposerClient,
	ProposerRequest,
	PythonRunner,
	SolverClient,
	SolverRequest,
	Task,
} from "../src/core/types.ts";

export function stubSolver(
	respond: (request: SolverRequest) => string | Promise<string>,
): SolverClient & { requests: SolverRequest[] } {
	const requests: SolverRequest[] = [];
	return {
		requests,
		async complete(request) {
			requests.push(request);
			return { text: await respond(request), stopReason: "stop", usage: { input: 10, output: 5, cost: 0.0001 } };
		},
	};
}

export function stubProposer(
	respond: (request: ProposerRequest, call: number) => string | Promise<string>,
): ProposerClient & { requests: ProposerRequest[] } {
	const requests: ProposerRequest[] = [];
	return {
		requests,
		async complete(request) {
			requests.push(request);
			return {
				text: await respond(request, requests.length),
				stopReason: "stop",
				usage: { input: 100, output: 50, cost: 0.01 },
			};
		},
	};
}

export function stubPython(): PythonRunner {
	return {
		async run(code) {
			const match = /print\((\d+)\s*\+\s*(\d+)\)/.exec(code);
			return match
				? { stdout: `${Number(match[1]) + Number(match[2])}\n`, stderr: "", exitCode: 0, timedOut: false }
				: { stdout: "", stderr: "unsupported", exitCode: 1, timedOut: false };
		},
	};
}

/** Last "a + b" in a prompt, or undefined. */
export function sumInPrompt(text: string): number | undefined {
	const matches = [...text.matchAll(/(\d+)\s*\+\s*(\d+)/g)];
	const last = matches[matches.length - 1];
	return last ? Number(last[1]) + Number(last[2]) : undefined;
}

export const TOY_INFO = { name: "toy", description: "toy task" } satisfies Pick<Task, "name" | "description">;
