import { readFile } from "node:fs/promises";
import { DEFAULT_PROPOSER_MODEL, DEFAULT_SOLVER_MODEL, defaultPythonPath, repoPath } from "../config.ts";
import { DEFAULT_BUDGETS } from "../core/capabilities.ts";
import { type AdaptSummary, adapt, QA_PROTOCOL, REASONING_GYM_PROTOCOL } from "../core/loop.ts";
import { createBedrockModels, PiProposerClient, PiSolverClient, requireModel } from "../llm/pi-clients.ts";
import { createTask } from "../tasks/registry.ts";
import { createPythonRunner } from "../tools/python.ts";
import { Semaphore } from "../util/concurrency.ts";

export interface AdaptRequest {
	task: string;
	rounds?: number;
	proposals?: number;
	protocol?: "rg" | "qa";
	solver?: string;
	proposer?: string;
	reasoning?: "off" | "minimal" | "low" | "medium" | "high";
	dev?: number;
	heldout?: number;
	seedHarness?: string;
	runDir?: string;
}

export interface AdaptService {
	run(request: AdaptRequest, log: (line: string) => void, signal?: AbortSignal): Promise<AdaptSummary>;
}

/** Runs the adaptation loop on Bedrock models; nothing is created until run() is called. */
export function createAdaptService(): AdaptService {
	return {
		async run(request, log, signal) {
			process.env.AWS_REGION ??= "us-east-1";
			const task = await createTask(request.task, { devSize: request.dev, heldoutSize: request.heldout });
			try {
				const models = createBedrockModels();
				const solver = new PiSolverClient({
					models,
					model: requireModel(models, request.solver ?? process.env.TTA_SOLVER_MODEL ?? DEFAULT_SOLVER_MODEL),
					limiter: new Semaphore(16),
					temperature: 0.7,
				});
				const reasoning = request.reasoning ?? "medium";
				const proposer = new PiProposerClient({
					models,
					model: requireModel(
						models,
						request.proposer ?? process.env.TTA_PROPOSER_MODEL ?? DEFAULT_PROPOSER_MODEL,
					),
					reasoning: reasoning === "off" ? undefined : reasoning,
				});
				const preset = request.protocol === "qa" ? QA_PROTOCOL : REASONING_GYM_PROTOCOL;
				const defaultSeed = task.name.startsWith("qa:") ? "qa-seed.js" : "rg-seed.js";
				const seedSource = await readFile(request.seedHarness ?? repoPath("seeds", defaultSeed), "utf8");
				const time = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				return await adapt({
					task,
					seedSource,
					config: {
						...preset,
						rounds: request.rounds ?? preset.rounds,
						proposals: request.proposals ?? preset.proposals,
						budgets: DEFAULT_BUDGETS,
						concurrency: 8,
						seed: 1,
					},
					deps: { solver, proposer, python: createPythonRunner({ pythonPath: defaultPythonPath() }) },
					runDir: request.runDir ?? repoPath("runs", `${time}-pi-${request.task.replace(/[^\w]+/g, "_")}`),
					log,
					signal,
				});
			} finally {
				await task.close?.();
			}
		},
	};
}
