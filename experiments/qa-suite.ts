// QA protocol (best-of-G, disjoint feedback and scoring questions) on multi-hop QA benchmarks, plus
// held-out scores of each adapted harness on the other benchmarks.
// Usage: AWS_PROFILE=... node experiments/qa-suite.ts --datasets hotpotqa,musique,2wiki --rounds 6 --proposals 4 --scoring 32 --heldout 150 --out results/qa-multistep.md
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PROPOSER_MODEL, DEFAULT_SOLVER_MODEL, repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { evaluateHarness } from "../src/core/executor.ts";
import { type AdaptSummary, adapt, QA_PROTOCOL } from "../src/core/loop.ts";
import type { Task } from "../src/core/types.ts";
import { createBedrockModels, PiProposerClient, PiSolverClient, requireModel } from "../src/llm/pi-clients.ts";
import { createQaTask, type QaDataset } from "../src/tasks/qa/task.ts";
import { Semaphore } from "../src/util/concurrency.ts";
import { fmt } from "../src/util/text.ts";

const { values } = parseArgs({
	options: {
		datasets: { type: "string" },
		solver: { type: "string" },
		proposer: { type: "string" },
		reasoning: { type: "string" },
		rounds: { type: "string" },
		proposals: { type: "string" },
		feedback: { type: "string" },
		scoring: { type: "string" },
		dev: { type: "string" },
		heldout: { type: "string" },
		tag: { type: "string" },
		out: { type: "string" },
	},
});
process.env.AWS_REGION ??= "us-east-1";
const datasets = (values.datasets ?? "hotpotqa").split(",") as QaDataset[];
const tag = values.tag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const models = createBedrockModels();
const solverId = values.solver ?? DEFAULT_SOLVER_MODEL;
const proposerId = values.proposer ?? DEFAULT_PROPOSER_MODEL;
const solver = new PiSolverClient({
	models,
	model: requireModel(models, solverId),
	limiter: new Semaphore(32),
	temperature: 0.6,
});
const proposer = new PiProposerClient({
	models,
	model: requireModel(models, proposerId),
	reasoning: (values.reasoning ?? "medium") as "medium",
});
const seedSource = await readFile(repoPath("seeds", "qa-seed.js"), "utf8");
const budgets = { ...DEFAULT_BUDGETS, maxTokensPerCall: 2048, questionTimeoutMs: 240_000 };
const tasks = new Map<QaDataset, Task>();
for (const name of datasets) {
	tasks.set(
		name,
		await createQaTask({
			name,
			devSize: Number(values.dev ?? 500),
			testSize: Number(values.heldout ?? 150),
			seed: 1,
		}),
	);
}

const summaries = new Map<QaDataset, AdaptSummary>();
const finals = new Map<QaDataset, string>();
for (const name of datasets) {
	const task = tasks.get(name) as Task;
	const runDir = repoPath("runs", `${tag}-qa-${name}`);
	const summary = await adapt({
		task,
		seedSource,
		config: {
			...QA_PROTOCOL,
			rounds: Number(values.rounds ?? QA_PROTOCOL.rounds),
			proposals: Number(values.proposals ?? QA_PROTOCOL.proposals),
			feedbackSize: Number(values.feedback ?? QA_PROTOCOL.feedbackSize),
			scoringSize: Number(values.scoring ?? QA_PROTOCOL.scoringSize),
			budgets,
			concurrency: 16,
			seed: 1,
		},
		deps: { solver, proposer },
		runDir,
		log: (line) => process.stderr.write(`[${name}] ${line}\n`),
	});
	summaries.set(name, summary);
	finals.set(name, await readFile(`${runDir}/final.js`, "utf8"));
}

const cross: string[] = [];
for (const [from, source] of finals) {
	const cells: string[] = [];
	for (const to of datasets) {
		if (to === from) {
			cells.push(fmt(summaries.get(from)?.finalHeldout ?? 0, 3));
			continue;
		}
		const task = tasks.get(to) as Task;
		const result = await evaluateHarness({
			task,
			source,
			questions: task.heldout,
			label: `cross-${from}-${to}`,
			deps: { solver, search: task.search },
			budgets,
			concurrency: 16,
		});
		cells.push(fmt(result.mean, 3));
	}
	cross.push(`| adapted on ${from} | ${cells.join(" | ")} |`);
}

const rounds = Math.max(...[...summaries.values()].map((s) => s.rounds.length));
const header = [
	"Benchmark",
	"Seed",
	...Array.from({ length: rounds }, (_, i) => `R${i + 1}`),
	"Δ",
	"Proposer $",
	"Solver $",
];
const rows = datasets.map((name) => {
	const s = summaries.get(name) as AdaptSummary;
	const perRound = s.rounds.map((r) => (r.heldout === undefined ? "–" : fmt(r.heldout, 3)));
	return `| ${name} | ${fmt(s.seedHeldout ?? 0, 3)} | ${perRound.join(" | ")} | ${fmt((s.finalHeldout ?? 0) - (s.seedHeldout ?? 0), 3)} | ${s.usage.proposer.cost.toFixed(2)} | ${s.usage.solver.cost.toFixed(2)} |`;
});
const table = [
	`# Multi-hop QA adaptation (${tag})`,
	"",
	`Solver ${solverId}, proposer ${proposerId}. QA protocol: best-of-G with G=${values.proposals ?? QA_PROTOCOL.proposals}, ${values.feedback ?? QA_PROTOCOL.feedbackSize} feedback and ${values.scoring ?? QA_PROTOCOL.scoringSize} disjoint scoring questions per round; held-out exact match after each round.`,
	"",
	`| ${header.join(" | ")} |`,
	`|${header.map(() => "---").join("|")}|`,
	...rows,
	"",
	"Held-out exact match of each final harness on every benchmark (diagonal: in-domain):",
	"",
	`| Harness | ${datasets.join(" | ")} |`,
	`|---|${datasets.map(() => "---").join("|")}|`,
	...cross,
	"",
].join("\n");
if (values.out) {
	await mkdir(dirname(values.out), { recursive: true });
	await writeFile(values.out, table);
}
process.stdout.write(table);
