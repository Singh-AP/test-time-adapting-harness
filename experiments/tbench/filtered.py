"""List trials whose agent run ended on a reply the provider's content filter blocked.

Such runs end for a provider reason, not an agent decision, so they are re-run with a fallback model
(--ak fallback_model=...). Usage: python3 experiments/tbench/filtered.py <job-dir> [--tasks]
"""

from __future__ import annotations

import json
import pathlib
import sys


def ended_filtered(session: pathlib.Path) -> bool:
	last = None
	for line in session.read_text(errors="replace").splitlines():
		try:
			message = json.loads(line).get("message") or {}
		except ValueError:
			continue
		if message.get("role") == "assistant":
			last = message
	return bool(last) and last.get("stopReason") == "error" and "content_filtered" in (last.get("errorMessage") or "")


def main(argv: list[str]) -> None:
	job = pathlib.Path(argv[0])
	hits = []
	for trial in sorted(job.glob("*__*")):
		session = trial / "agent" / "session.jsonl"
		if (trial / "result.json").exists() and session.exists() and ended_filtered(session):
			hits.append(trial.name.split("__")[0])
	print(" ".join(hits) if "--tasks" in argv else "\n".join(hits))


if __name__ == "__main__":
	main(sys.argv[1:])
