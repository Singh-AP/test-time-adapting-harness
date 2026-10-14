#!/bin/bash
# Run the pi harness on Terminal-Bench 4.0 tasks on a runner host (python/tbench/aws_infra.py).
# Usage: experiments/tbench/run.sh <job-name> <harness-dir> <model-id> <dev|heldout|all> <gpu: include|exclude|only> <n-concurrent> [harbor args...]
# Example: experiments/tbench/run.sh v0-sonnet harnesses/tbench/v0 global.anthropic.claude-sonnet-5-5 all exclude 40
set -euo pipefail
cd "$(dirname "$0")/../.."
job=$1 harness=$2 model=$3 subset=$4 gpu=$5 n=$6
shift 6
read -r -a filters <<< "$(python3 experiments/tbench/split.py select experiments/tbench/splits/tb4.json "$subset" --gpu "$gpu")"
ulimit -n 65536 2>/dev/null || true
git rev-parse --short HEAD > "$HOME/jobs/$job.commit" 2>/dev/null || true
PYTHONPATH="$PWD" exec .venv-harbor/bin/harbor run -d terminal-bench/terminal-bench@4.0.0 -e docker \
	-a python.tbench.harbor_agent:PiHarnessAgent -m "$model" --ak harness="$harness" \
	"${filters[@]}" -n "$n" -o "$HOME/jobs" --job-name "$job" -y "$@"
