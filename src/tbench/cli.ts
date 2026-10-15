/**
 * Harness learning for Terminal-Bench (runs locally; benchmark jobs run on the runner hosts).
 *
 *   node src/tbench/cli.ts report  --jobs runs/tbench/<job> [--jobs ...] [--subset dev]
 *   node src/tbench/cli.ts propose --parent harnesses/tbench/v1 --jobs runs/tbench/<job> --out harnesses/tbench/v2
 *                                  [--proposer <provider/model>] [--thinking high] [--history file.md]
 *
 * Reports and proposals only ever include dev-split tasks (experiments/tbench/splits/tb4.json).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { repoPath } from "../config.ts";
import { resolveModel } from "../llm/model-spec.ts";
import { proposeHarness } from "./propose.ts";
import { buildTbenchReport, loadTrials, type TrialSummary } from "./report.ts";

interface Split {
	dev: string[];
	heldout: string[];
}

async function devReport(jobs: string[], splitPath: string, subset: string) {
	const split = JSON.parse(await readFile(splitPath, "utf8")) as Split;
	const allowed = new Set(subset === "all" ? [...split.dev, ...split.heldout] : split[subset as keyof Split]);
	const trials = (await loadTrials(jobs)).filter((t) => allowed.has(t.task));
	return { trials, report: buildTbenchReport(trials, { allowedTasks: allowed }), split };
}

/** Names the harness must not mention: dev task names and the hidden tests they failed. */
function forbiddenStrings(trials: TrialSummary[], split: Split): string[] {
	const names = new Set<string>();
	for (const task of split.dev) names.add(task.split("/").pop() as string);
	for (const t of trials) for (const test of t.failedTests) names.add(test);
	return [...names];
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const { values } = parseArgs({
		args: rest,
		options: {
			jobs: { type: "string", multiple: true, default: [] },
			split: { type: "string", default: repoPath("experiments", "tbench", "splits", "tb4.json") },
			subset: { type: "string", default: "dev" },
			parent: { type: "string" },
			out: { type: "string" },
			proposer: { type: "string", default: "us.anthropic.claude-opus-5-5" },
			thinking: { type: "string", default: "high" },
			history: { type: "string" },
		},
	});
	const jobs = values.jobs as string[];
	if (command === "report") {
		process.stdout.write((await devReport(jobs, values.split as string, values.subset as string)).report);
		return;
	}
	if (command === "propose") {
		if (!values.parent || !values.out) throw new Error("propose needs --parent and --out");
		if ((values.subset as string) !== "dev") throw new Error("proposals may only use dev tasks");
		const { trials, report, split } = await devReport(jobs, values.split as string, "dev");
		const runtime = await ModelRuntime.create({
			authPath: join(repoPath("runs"), ".pi-proposer", "auth.json"),
			modelsPath: join(repoPath("runs"), ".pi-proposer", "models.json"),
			refreshOnCreate: false,
		});
		const model = resolveModel(runtime, values.proposer as string);
		const result = await proposeHarness({
			runtime,
			model,
			thinkingLevel: values.thinking as ThinkingLevel,
			parentDir: values.parent,
			outDir: values.out,
			report,
			history: values.history ? await readFile(values.history, "utf8") : undefined,
			forbidden: forbiddenStrings(trials, split),
		});
		console.log(
			`status: ${result.status}${result.reason ? ` (${result.reason})` : ""}; proposer cost $${result.cost.toFixed(2)}`,
		);
		console.log(`## Diagnosis\n${result.diagnosis}\n\n## Change manifest\n${result.manifest}`);
		if (result.status !== "edit") process.exitCode = 2;
		return;
	}
	throw new Error(`unknown command ${command}; use report or propose`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
