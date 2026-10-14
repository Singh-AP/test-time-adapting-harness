"""Deterministic dev / held-out split of a Terminal-Bench dataset, stratified by task category.

Harness changes may only be informed by dev-task results; held-out tasks are only reported (paper App. B: the
proposer never sees held-out questions). Within each category, tasks are ordered by a hash of their name and
assigned alternately.

Usage:
  python experiments/tbench/split.py make <dataset-dir> > experiments/tbench/splits/tb4.json
  python experiments/tbench/split.py select <split.json> <dev|heldout|all> [--gpu include|exclude|only]
    prints Harbor task filters: -i <task> -i <task> ...
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys


def split(tasks: dict[str, str]) -> dict[str, list[str]]:
	"""`tasks` maps task name to category."""
	by_category: dict[str, list[str]] = {}
	for name, category in tasks.items():
		by_category.setdefault(category, []).append(name)
	dev: list[str] = []
	heldout: list[str] = []
	for category in sorted(by_category):
		names = sorted(by_category[category], key=lambda n: hashlib.sha256(n.encode()).hexdigest())
		for i, name in enumerate(names):
			(dev if i % 2 == 0 else heldout).append(name)
	return {"dev": sorted(dev), "heldout": sorted(heldout)}


def make(dataset: pathlib.Path) -> dict[str, object]:
	import tomllib

	tasks: dict[str, str] = {}
	gpu: list[str] = []
	for task_toml in sorted(dataset.glob("*/task.toml")):
		config = tomllib.loads(task_toml.read_text())
		name = config["task"]["name"]
		tasks[name] = config.get("metadata", {}).get("category", "unknown")
		if (config.get("environment", {}).get("gpus") or 0) > 0:
			gpu.append(name)
	return {"dataset": "terminal-bench/terminal-bench@4.0.0", **split(tasks), "gpu": sorted(gpu)}


def select(spec: dict[str, list[str]], subset: str, gpu: str = "include") -> list[str]:
	names = spec["dev"] + spec["heldout"] if subset == "all" else spec[subset]
	gpu_tasks = set(spec.get("gpu", []))
	if gpu == "exclude":
		names = [n for n in names if n not in gpu_tasks]
	elif gpu == "only":
		names = [n for n in names if n in gpu_tasks]
	return sorted(names)


if __name__ == "__main__":
	if sys.argv[1] == "make":
		print(json.dumps(make(pathlib.Path(sys.argv[2])), indent=2))
	elif sys.argv[1] == "select":
		gpu = sys.argv[sys.argv.index("--gpu") + 1] if "--gpu" in sys.argv else "include"
		chosen = select(json.loads(pathlib.Path(sys.argv[2]).read_text()), sys.argv[3], gpu)
		print(" ".join(f"-i {name}" for name in chosen))
	else:
		raise SystemExit(__doc__)
