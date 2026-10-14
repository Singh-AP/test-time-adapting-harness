"""Summarize Harbor jobs of the pi harness: per-task reward, cost and time, aggregated by split.

Usage: python3 experiments/tbench/summarize.py <job-dir>... [--split experiments/tbench/splits/tb4.json] [--out f.md]
A task's reward is the mean over its trials; errored trials count as 0.
"""

from __future__ import annotations

import json
import pathlib
import statistics
import sys


def trial_rows(job: pathlib.Path) -> list[dict]:
	rows = []
	for result_path in sorted(job.glob("*__*/result.json")):
		trial = result_path.parent
		r = json.loads(result_path.read_text())
		agent = {}
		agent_path = trial / "agent" / "agent-result.json"
		if agent_path.exists():
			agent = json.loads(agent_path.read_text())
		rewards = (r.get("verifier_result") or {}).get("rewards") or {}
		task = (r.get("task_name") or (json.loads((trial / "config.json").read_text()).get("task") or {}).get("name") or trial.name.split("__")[0])
		task = task if "/" in task else f"terminal-bench/{task}"
		rows.append(
			{
				"task": task,
				"trial": trial.name,
				"reward": float(rewards.get("reward") or 0.0),
				"exception": (r.get("exception_info") or {}).get("exception_type"),
				"cost": float(agent.get("cost") or (r.get("agent_result") or {}).get("cost_usd") or 0.0),
				"minutes": float(agent.get("elapsedSec") or 0.0) / 60,
				"turns": agent.get("turns"),
				"stop": agent.get("stopReason"),
				"reviews": "".join("P" if x.get("pass") else "F" for x in agent.get("reviews", [])),
			}
		)
	return rows


def main(argv: list[str]) -> None:
	split_path = pathlib.Path(argv[argv.index("--split") + 1]) if "--split" in argv else pathlib.Path(__file__).with_name("splits") / "tb4.json"
	out = pathlib.Path(argv[argv.index("--out") + 1]) if "--out" in argv else None
	jobs = [pathlib.Path(a) for a in argv if not a.startswith("--") and a not in (str(split_path), str(out))]
	split = json.loads(split_path.read_text())
	membership = {t: "dev" for t in split["dev"]} | {t: "heldout" for t in split["heldout"]}
	rows = [row for job in jobs for row in trial_rows(job)]
	by_task: dict[str, list[dict]] = {}
	for row in rows:
		by_task.setdefault(row["task"], []).append(row)
	lines = ["| Task | Split | Reward | Trials | Errors | Cost $ | Minutes | Turns | Stop | Reviews |", "|---|---|---|---|---|---|---|---|---|---|"]
	for task in sorted(by_task):
		trials = by_task[task]
		lines.append(
			f"| {task.split('/')[-1]} | {membership.get(task, '?')} | {statistics.mean(t['reward'] for t in trials):.2f} | {len(trials)} "
			f"| {sum(1 for t in trials if t['exception'])} | {sum(t['cost'] for t in trials):.2f} | {statistics.mean(t['minutes'] for t in trials):.0f} "
			f"| {statistics.mean((t['turns'] or 0) for t in trials):.0f} | {','.join(sorted({str(t['stop']) for t in trials}))} | {' '.join(t['reviews'] for t in trials if t['reviews'])} |"
		)
	summary = ["| Subset | Tasks | Mean reward | Cost $ | Mean minutes |", "|---|---|---|---|---|"]
	for subset in ("dev", "heldout", "all"):
		tasks = [t for t in by_task if subset == "all" or membership.get(t) == subset]
		if not tasks:
			continue
		rewards = [statistics.mean(r["reward"] for r in by_task[t]) for t in tasks]
		cost = sum(r["cost"] for t in tasks for r in by_task[t])
		minutes = statistics.mean(r["minutes"] for t in tasks for r in by_task[t])
		summary.append(f"| {subset} | {len(tasks)} | {statistics.mean(rewards):.3f} | {cost:.2f} | {minutes:.0f} |")
	text = "\n".join(summary) + "\n\n" + "\n".join(lines) + "\n"
	if out:
		out.write_text(text)
	print(text)


if __name__ == "__main__":
	main(sys.argv[1:])
