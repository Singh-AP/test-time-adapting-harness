#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { DEFAULT_PROPOSER_MODEL, DEFAULT_SOLVER_MODEL, defaultPythonPath, repoPath } from "./config.ts";
import { type Budgets, DEFAULT_BUDGETS } from "./core/capabilities.ts";
import { evaluateHarness } from "./core/executor.ts";
import { independentRevisions } from "./core/independent.ts";
import { type AdaptConfig, adapt, QA_PROTOCOL, REASONING_GYM_PROTOCOL, renderUsage } from "./core/loop.ts";
import { createBedrockModels, PiProposerClient, PiSolverClient, requireModel } from "./llm/pi-clients.ts";
import { ReasoningGymBridge } from "./tasks/reasoning-gym/bridge.ts";
import { createTask } from "./tasks/registry.ts";
import { createPythonRunner } from "./tools/python.ts";
import { Semaphore } from "./util/concurrency.ts";
import { fmt } from "./util/text.ts";

const HELP = `tta: test-time harness adaptation on pi

Usage:
  tta adapt --task <spec> [options]        Run the adaptation loop (paper Eq. 4)
  tta independent --task <spec> [options]  Sample independent single-step revisions of the seed
  tta eval --task <spec> --harness <file>  Score a harness on dev and held-out questions
  tta families                             List Reasoning Gym families

Task specs: toy:addition, rg:<family>

Options:
  --seed-harness <file>      Seed harness (default seeds/rg-seed.js)
  --harness <file>           Harness to score (eval)
  --set dev|heldout|both     Question sets to score (eval, default both)
  --solver <id>              Bedrock solver model (default $TTA_SOLVER_MODEL or ${DEFAULT_SOLVER_MODEL})
  --proposer <id>            Bedrock proposer model (default $TTA_PROPOSER_MODEL or ${DEFAULT_PROPOSER_MODEL})
  --reasoning <level>        Proposer thinking: off|minimal|low|medium|high (default medium)
  --protocol rg|qa           Selection protocol preset (default rg)
  --rounds <n>               Revision rounds T
  --proposals <n>            Proposals per round G
  --feedback <n|all>         Feedback questions per round
  --scoring <n|all>          Scoring questions per round
  --attempts <n>             Generation attempts per proposal
  --max-lines <n>            Harness line limit
  --dev <n> --heldout <n>    Question pool sizes
  --concurrency <n>          Questions in parallel per evaluation (default 8)
  --solver-concurrency <n>   Concurrent solver requests (default 16)
  --llm-calls <n>            Solver calls per question (default ${DEFAULT_BUDGETS.llmCalls})
  --question-timeout <s>     Seconds per question (default ${DEFAULT_BUDGETS.questionTimeoutMs / 1000})
  --temperature <t>          Default solver temperature (default 0.7)
  --branch-hints             Diversify parallel proposals
  --no-heldout               Skip held-out evaluation
  --run-dir <dir>            Artifact directory (default runs/<time>-<command>-<task>)
  --seed <n>                 Sampling seed (default 1)

Credentials come from the AWS credential chain (set AWS_PROFILE). AWS_REGION defaults to us-east-1.
`;

const OPTIONS = {
	task: { type: "string" },
	"seed-harness": { type: "string" },
	harness: { type: "string" },
	set: { type: "string" },
	solver: { type: "string" },
	proposer: { type: "string" },
	reasoning: { type: "string" },
	protocol: { type: "string" },
	rounds: { type: "string" },
	proposals: { type: "string" },
	feedback: { type: "string" },
	scoring: { type: "string" },
	attempts: { type: "string" },
	"max-lines": { type: "string" },
	dev: { type: "string" },
	heldout: { type: "string" },
	concurrency: { type: "string" },
	"solver-concurrency": { type: "string" },
	"llm-calls": { type: "string" },
	"question-timeout": { type: "string" },
	temperature: { type: "string" },
	"branch-hints": { type: "boolean" },
	"no-heldout": { type: "boolean" },
	"run-dir": { type: "string" },
	seed: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

function log(line: string): void {
	process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

function integer(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new Error(`expected a non-negative integer, got "${value}"`);
	return n;
}

function optionalInteger(value: string | undefined): number | undefined {
	return value === undefined ? undefined : integer(value, 0);
}

function sizeOrAll(value: string | undefined, fallback: number | "all"): number | "all" {
	return value === undefined ? fallback : value === "all" ? "all" : integer(value, 0);
}

function reasoningLevel(value: string | undefined): ThinkingLevel | undefined {
	if (value === undefined) return "medium";
	if (value === "off") return undefined;
	return value as ThinkingLevel;
}

function defaultRunDir(command: string, spec: string): string {
	const time = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return repoPath("runs", `${time}-${command}-${spec.replace(/[^\w]+/g, "_")}`);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
	const command = positionals[0];
	if (!command || values.help) {
		process.stdout.write(HELP);
		return;
	}
	process.env.AWS_REGION ??= "us-east-1";
	if (command === "families") {
		const bridge = new ReasoningGymBridge({ pythonPath: defaultPythonPath() });
		try {
			process.stdout.write(`${(await bridge.families()).join("\n")}\n`);
		} finally {
			await bridge.close();
		}
		return;
	}
	if (!["adapt", "independent", "eval"].includes(command))
		throw new Error(`Unknown command "${command}". Run tta --help.`);
	const spec = values.task;
	if (!spec) throw new Error("--task is required");

	const task = await createTask(spec, {
		devSize: optionalInteger(values.dev),
		heldoutSize: optionalInteger(values.heldout),
	});
	try {
		const models = createBedrockModels();
		const solverModel = requireModel(models, values.solver ?? process.env.TTA_SOLVER_MODEL ?? DEFAULT_SOLVER_MODEL);
		const solver = new PiSolverClient({
			models,
			model: solverModel,
			limiter: new Semaphore(integer(values["solver-concurrency"], 16)),
			temperature: values.temperature === undefined ? 0.7 : Number(values.temperature),
			onRetry: (attempt, message) => log(`solver retry ${attempt}: ${message.slice(0, 160)}`),
		});
		const python = createPythonRunner({ pythonPath: defaultPythonPath() });
		const budgets: Budgets = {
			...DEFAULT_BUDGETS,
			llmCalls: integer(values["llm-calls"], DEFAULT_BUDGETS.llmCalls),
			questionTimeoutMs: integer(values["question-timeout"], DEFAULT_BUDGETS.questionTimeoutMs / 1000) * 1000,
		};
		const concurrency = integer(values.concurrency, 8);
		log(
			`task ${task.name}: ${task.dev.length} dev / ${task.heldout.length} held-out; solver ${solverModel.id}; AWS profile ${process.env.AWS_PROFILE ?? "(default chain)"}`,
		);

		if (command === "eval") {
			if (!values.harness) throw new Error("--harness is required for eval");
			const source = await readFile(values.harness, "utf8");
			const sets = values.set ?? "both";
			for (const [name, questions] of [
				["dev", task.dev],
				["heldout", task.heldout],
			] as const) {
				if (sets !== "both" && sets !== name) continue;
				const result = await evaluateHarness({
					task,
					source,
					questions,
					label: name,
					deps: { solver, python, search: task.search },
					budgets,
					concurrency,
				});
				const counts = Object.entries(result.counts)
					.map(([k, v]) => `${k} ${v}`)
					.join(", ");
				process.stdout.write(
					`${name}: ${fmt(result.mean)} on ${questions.length} (${counts}); ${result.calls.llm} solver calls, $${result.usage.cost.toFixed(4)}\n`,
				);
			}
			return;
		}

		const proposerModel = requireModel(
			models,
			values.proposer ?? process.env.TTA_PROPOSER_MODEL ?? DEFAULT_PROPOSER_MODEL,
		);
		const proposer = new PiProposerClient({
			models,
			model: proposerModel,
			reasoning: reasoningLevel(values.reasoning),
			onRetry: (attempt, message) => log(`proposer retry ${attempt}: ${message.slice(0, 160)}`),
		});
		const seedSource = await readFile(values["seed-harness"] ?? repoPath("seeds", "rg-seed.js"), "utf8");
		const runDir = values["run-dir"] ?? defaultRunDir(command, spec);
		const preset = values.protocol === "qa" ? QA_PROTOCOL : REASONING_GYM_PROTOCOL;
		const seed = integer(values.seed, 1);
		log(`proposer ${proposerModel.id}; artifacts in ${runDir}`);

		if (command === "independent") {
			const summary = await independentRevisions({
				task,
				seedSource,
				proposals: integer(values.proposals, 8),
				deps: { solver, proposer, python },
				config: {
					budgets,
					concurrency,
					attempts: integer(values.attempts, preset.attempts),
					maxLines: integer(values["max-lines"], preset.maxLines),
					seed,
					branchHints: values["branch-hints"] ?? true,
					feedbackSize: sizeOrAll(values.feedback, preset.feedbackSize),
				},
				runDir,
				log,
			});
			process.stdout.write(
				`${task.name}: seed held-out ${fmt(summary.seedHeldout)}; ${summary.proposals.length} proposals mean ${fmt(summary.mean)}, best ${fmt(summary.bestOf)}, failed ${fmt(summary.failedRate * 100, 1)}%\n${renderUsage("Solver", summary.usage.solver)}\n${renderUsage("Proposer", summary.usage.proposer)}\n`,
			);
			return;
		}

		const config: AdaptConfig = {
			...preset,
			rounds: integer(values.rounds, preset.rounds),
			proposals: integer(values.proposals, preset.proposals),
			feedbackSize: sizeOrAll(values.feedback, preset.feedbackSize),
			scoringSize: sizeOrAll(values.scoring, preset.scoringSize),
			attempts: integer(values.attempts, preset.attempts),
			maxLines: integer(values["max-lines"], preset.maxLines),
			evaluateHeldout: !values["no-heldout"],
			branchHints: values["branch-hints"] ?? preset.branchHints,
			budgets,
			concurrency,
			seed,
		};
		const summary = await adapt({ task, seedSource, config, deps: { solver, proposer, python }, runDir, log });
		const lines = summary.rounds.map(
			(r) => `round ${r.round}: ${r.selection.reason}; held-out ${r.heldout === undefined ? "-" : fmt(r.heldout)}`,
		);
		process.stdout.write(
			`${[`${task.name}: held-out seed ${summary.seedHeldout === undefined ? "-" : fmt(summary.seedHeldout)}`, ...lines, renderUsage("Solver", summary.usage.solver), renderUsage("Proposer", summary.usage.proposer), `artifacts: ${runDir}`].join("\n")}\n`,
		);
	} finally {
		await task.close?.();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
