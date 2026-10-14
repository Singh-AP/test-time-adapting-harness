/**
 * Paired comparison of harness runs on the same tasks (dev split, offline set by default).
 * Usage: node experiments/tbench/compare.ts <label>=<job-dir>[,<job-dir>...] ... [--subset dev|heldout|all]
 */
import { readFile } from "node:fs/promises";
import { loadTrials, type TrialSummary } from "../../src/tbench/report.ts";

const args = process.argv.slice(2);
const subset = args.includes("--subset") ? args[args.indexOf("--subset") + 1] : "dev";
const split = JSON.parse(await readFile(new URL("splits/tb4.json", import.meta.url), "utf8"));
const pool: string[] = subset === "all" ? [...split.dev, ...split.heldout] : split[subset];
const allowed = new Set(pool.filter((t: string) => (split.offline ?? pool).includes(t)));
const runs: { label: string; byTask: Map<string, TrialSummary[]> }[] = [];
for (const spec of args.filter((a) => a.includes("="))) {
	const [label, dirs] = spec.split("=");
	const byTask = new Map<string, TrialSummary[]>();
	for (const t of await loadTrials(dirs.split(","))) {
		if (!allowed.has(t.task)) continue;
		byTask.set(t.task, [...(byTask.get(t.task) ?? []), t]);
	}
	runs.push({ label, byTask });
}
const tasks = [...allowed].filter((t) => runs.some((r) => r.byTask.has(t))).sort();
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log(`| Task | ${runs.map((r) => r.label).join(" | ")} |`);
console.log(`|---|${runs.map(() => "---").join("|")}|`);
for (const task of tasks) {
	const cells = runs.map((r) => {
		const ts = r.byTask.get(task);
		return ts ? mean(ts.map((t) => t.reward)).toFixed(2) : "-";
	});
	console.log(`| ${task.split("/")[1]} | ${cells.join(" | ")} |`);
}
const common = tasks.filter((t) => runs.every((r) => r.byTask.has(t)));
console.log(`\nTasks finished in every run: ${common.length}`);
for (const r of runs) {
	const rewards = common.map((t) => mean((r.byTask.get(t) ?? []).map((x) => x.reward)));
	const cost = common.reduce((s, t) => s + (r.byTask.get(t) ?? []).reduce((c, x) => c + x.cost, 0), 0);
	const all = [...r.byTask.values()].map((ts) => mean(ts.map((t) => t.reward)));
	console.log(
		`${r.label}: ${mean(rewards).toFixed(3)} on common tasks ($${cost.toFixed(0)}); ${mean(all).toFixed(3)} on its ${all.length} finished tasks`,
	);
}
