// Seed and tool-loop development scores per solver model and Reasoning Gym family.
// Usage: AWS_PROFILE=... node experiments/calibrate.ts --solvers a,b --families maze,count_primes --dev 20 --out results/calibration.md
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { defaultPythonPath, repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { evaluateHarness } from "../src/core/executor.ts";
import { createModelCatalog, PiSolverClient, requireModel } from "../src/llm/pi-clients.ts";
import { ReasoningGymBridge } from "../src/tasks/reasoning-gym/bridge.ts";
import { createReasoningGymTask } from "../src/tasks/reasoning-gym/task.ts";
import { createPythonRunner } from "../src/tools/python.ts";
import { Semaphore } from "../src/util/concurrency.ts";
import { fmt } from "../src/util/text.ts";

const { values } = parseArgs({
	options: {
		solvers: { type: "string" },
		families: { type: "string" },
		dev: { type: "string" },
		out: { type: "string" },
	},
});
process.env.AWS_REGION ??= "us-east-1";
const solvers = (values.solvers ?? "us.meta.llama3-1-8b-instruct-v1:0").split(",");
const families = (values.families ?? "maze,count_primes").split(",");
const devSize = Number(values.dev ?? 20);
const seeds = {
	seed: await readFile(repoPath("seeds", "rg-seed.js"), "utf8"),
	"tool-loop": await readFile(repoPath("seeds", "tool-loop.js"), "utf8"),
};
const models = createModelCatalog();
const bridge = new ReasoningGymBridge({ pythonPath: defaultPythonPath() });
const python = createPythonRunner({ pythonPath: defaultPythonPath() });
const limiter = new Semaphore(16);
const rows: string[] = [];
try {
	for (const family of families) {
		const task = await createReasoningGymTask({ family, bridge, devSize, heldoutSize: 0 });
		for (const id of solvers) {
			const solver = new PiSolverClient({ models, model: requireModel(models, id), limiter, temperature: 0.7 });
			const scores: string[] = [];
			let cost = 0;
			for (const [name, source] of Object.entries(seeds)) {
				const result = await evaluateHarness({
					task,
					source,
					questions: task.dev,
					label: name,
					deps: { solver, python },
					budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 180_000 },
					concurrency: 8,
				});
				scores.push(fmt(result.mean));
				cost += result.usage.cost;
			}
			rows.push(`| ${family} | ${id} | ${scores.join(" | ")} | $${cost.toFixed(4)} |`);
			process.stderr.write(`${rows[rows.length - 1]}\n`);
		}
	}
} finally {
	await bridge.close();
}
const table = [
	`# Solver calibration (${devSize} dev questions per family)`,
	"",
	"| Family | Solver | Seed | Tool loop | Cost |",
	"|---|---|---|---|---|",
	...rows,
	"",
].join("\n");
if (values.out) {
	await mkdir(dirname(values.out), { recursive: true });
	await writeFile(values.out, table);
}
process.stdout.write(table);
