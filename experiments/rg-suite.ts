// Runs the Reasoning Gym protocol (T rounds, G=1, retain if dev improves) on several families.
// Usage: AWS_PROFILE=... node experiments/rg-suite.ts --families maze,count_primes --rounds 5 --out results/reasoning-gym-multistep.md
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PROPOSER_MODEL, DEFAULT_SOLVER_MODEL, defaultPythonPath, repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { type AdaptSummary, adapt, REASONING_GYM_PROTOCOL } from "../src/core/loop.ts";
import { createModelCatalog, PiProposerClient, PiSolverClient, requireModel } from "../src/llm/pi-clients.ts";
import { createAgenticProposerForModel } from "../src/proposers/agentic.ts";
import { ReasoningGymBridge } from "../src/tasks/reasoning-gym/bridge.ts";
import { createReasoningGymTask } from "../src/tasks/reasoning-gym/task.ts";
import { createPythonRunner } from "../src/tools/python.ts";
import { mapLimit, Semaphore } from "../src/util/concurrency.ts";
import { fmt } from "../src/util/text.ts";

const { values } = parseArgs({
	options: {
		families: { type: "string" },
		solver: { type: "string" },
		proposer: { type: "string" },
		reasoning: { type: "string" },
		"proposer-mode": { type: "string" },
		"feedback-runs": { type: "string" },
		"agent-timeout": { type: "string" },
		playbook: { type: "string" },
		rounds: { type: "string" },
		dev: { type: "string" },
		heldout: { type: "string" },
		parallel: { type: "string" },
		tag: { type: "string" },
		out: { type: "string" },
	},
});
process.env.AWS_REGION ??= "us-east-1";
const families = (values.families ?? "maze").split(",");
const rounds = Number(values.rounds ?? REASONING_GYM_PROTOCOL.rounds);
const tag = values.tag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const models = createModelCatalog();
const solverId = values.solver ?? DEFAULT_SOLVER_MODEL;
const proposerId = values.proposer ?? DEFAULT_PROPOSER_MODEL;
const solver = new PiSolverClient({
	models,
	model: requireModel(models, solverId),
	limiter: new Semaphore(24),
	temperature: 0.7,
});
const proposer = new PiProposerClient({
	models,
	model: requireModel(models, proposerId),
	reasoning: (values.reasoning ?? "medium") as "medium",
});
const propose =
	values["proposer-mode"] === "agentic"
		? await createAgenticProposerForModel({
				agentDir: repoPath("runs", `${tag}-pi-agent`),
				model: proposerId,
				thinkingLevel: (values.reasoning ?? "medium") as "medium",
				maxFeedbackRuns: Number(values["feedback-runs"] ?? 3),
				timeoutMs: Number(values["agent-timeout"] ?? 1200) * 1000,
			})
		: undefined;
const python = createPythonRunner({ pythonPath: defaultPythonPath(), maxConcurrent: 12 });
const bridge = new ReasoningGymBridge({ pythonPath: defaultPythonPath() });
const playbook = values.playbook ? await readFile(values.playbook, "utf8") : undefined;
const seedSource = await readFile(repoPath("seeds", "rg-seed.js"), "utf8");

const summaries = await mapLimit(
	families,
	Number(values.parallel ?? 2),
	async (family): Promise<AdaptSummary | undefined> => {
		try {
			const task = await createReasoningGymTask({
				family,
				bridge,
				devSize: Number(values.dev ?? 25),
				heldoutSize: Number(values.heldout ?? 75),
			});
			return await adapt({
				task,
				seedSource,
				config: {
					...REASONING_GYM_PROTOCOL,
					playbook,
					rounds,
					budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 180_000 },
					concurrency: 8,
					seed: 1,
				},
				deps: propose ? { solver, propose, python } : { solver, proposer, python },
				runDir: repoPath("runs", `${tag}-rg-${family}`),
				log: (line) => process.stderr.write(`[${family}] ${line}\n`),
			});
		} catch (error) {
			process.stderr.write(`[${family}] failed: ${error instanceof Error ? error.message : String(error)}\n`);
			return undefined;
		}
	},
);
await bridge.close();

const header = [
	"Family",
	"Seed",
	...Array.from({ length: rounds }, (_, i) => `R${i + 1}`),
	"Δ",
	"Proposer $",
	"Solver $",
];
const rows: string[] = [];
const finals: number[] = [];
const seeds: number[] = [];
summaries.forEach((s, i) => {
	if (!s || s.seedHeldout === undefined || s.finalHeldout === undefined) {
		rows.push(`| ${families[i]} | failed |`);
		return;
	}
	seeds.push(s.seedHeldout);
	finals.push(s.finalHeldout);
	const perRound = s.rounds.map((r) => (r.heldout === undefined ? "–" : fmt(r.heldout, 2)));
	rows.push(
		`| ${families[i]} | ${fmt(s.seedHeldout, 2)} | ${perRound.join(" | ")} | ${fmt(s.finalHeldout - s.seedHeldout, 2)} | ${s.usage.proposer.cost.toFixed(2)} | ${s.usage.solver.cost.toFixed(2)} |`,
	);
});
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const table = [
	`# Reasoning Gym multistep adaptation (${tag})`,
	"",
	`Solver ${solverId}, proposer ${proposerId}. Proposer mode ${values["proposer-mode"] ?? "single"}${playbook ? ", with playbook" : ""}. Protocol: ${rounds} rounds, one proposal per round, retained only if the development score improves; held-out scores after each round.`,
	"",
	`| ${header.join(" | ")} |`,
	`|${header.map(() => "---").join("|")}|`,
	...rows,
	"",
	`Mean held-out: seed ${fmt(mean(seeds), 3)} -> final ${fmt(mean(finals), 3)} over ${finals.length} families.`,
	"",
].join("\n");
if (values.out) {
	await mkdir(dirname(values.out), { recursive: true });
	await writeFile(values.out, table);
}
process.stdout.write(table);
