// Structural audit of adapted harnesses (paper Fig. 6b): classifies each run's final harness from the
// solver and python calls it made per held-out question.
// Usage: node experiments/audit.ts --out results/audit.md runs/<run-dir>...
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { EvalResult } from "../src/core/types.ts";
import { classifyHarness, type HarnessClass } from "../src/learning/audit.ts";
import { fmt } from "../src/util/text.ts";

const { values, positionals } = parseArgs({ options: { out: { type: "string" } }, allowPositionals: true });

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

const rows: string[] = [];
const counts = new Map<HarnessClass, number>();
for (const run of positionals) {
	const config = await readJson<{ task?: { name?: string } }>(join(run, "config.json"));
	const rounds = (await readdir(run).catch(() => [] as string[])).filter((d) => /^round-\d+$/.test(d)).sort();
	const seed = await readJson<EvalResult>(join(run, "round-00", "heldout.json"));
	let final: EvalResult | undefined;
	for (const dir of [...rounds].reverse()) {
		final = await readJson<EvalResult>(join(run, dir, "heldout.json"));
		if (final) break;
	}
	if (!seed || !final) continue;
	const n = Math.max(final.outcomes.length, 1);
	const llm = final.calls.llm / n;
	const python = final.calls.python / n;
	const search = final.calls.search / n;
	const kind: HarnessClass =
		final.harnessHash === seed.harnessHash ? "single-call" : classifyHarness({ llm, python, search });
	const label = final.harnessHash === seed.harnessHash ? "seed (unchanged)" : kind;
	counts.set(kind, (counts.get(kind) ?? 0) + 1);
	rows.push(
		`| ${config?.task?.name ?? run} | ${fmt(seed.mean, 2)} | ${fmt(final.mean, 2)} | ${fmt(llm, 2)} | ${fmt(python, 2)} | ${fmt(search, 2)} | ${label} |`,
	);
}

const table = [
	"# Structure of adapted harnesses",
	"",
	"Average calls per held-out question made by each run's final harness. Classes: algorithm-js / algorithm-python (fewer than 0.2 solver calls: the harness computes answers itself, in JavaScript or in Python the proposer wrote), interpreter (solver calls plus python: the solver writes code the harness runs), multi-call (more than 1.5 solver calls), single-call, retrieval (search calls).",
	"",
	"| Task | Seed held-out | Final held-out | Solver calls | Python calls | Searches | Class |",
	"|---|---|---|---|---|---|---|",
	...rows,
	"",
	`Counts: ${[...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}.`,
	"",
].join("\n");
if (values.out) await writeFile(values.out, table);
process.stdout.write(table);
