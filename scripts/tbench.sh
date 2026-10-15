#!/bin/bash
# Runs the pi harness agent on Terminal-Bench with Harbor and Docker.
# Usage: scripts/tbench.sh -m <provider/model> [--harness <dir>] [harbor run options...]
#   --harness <dir>   harness directory (default harnesses/tbench/v6)
#   Everything else goes to `harbor run`, for example:
#     -i terminal-bench/<task>   run one task (repeatable; default: the whole dataset)
#     -n <k>                     concurrent trials
#     -k <k>                     trials per task
#     -o <dir>                   output directory (default jobs/)
#     --ak thinking=<level>      override the harness thinking level (off, low, medium, high, max)
#     --ak fallback_model=<m>    model to finish on when the provider blocks a reply
#     --ak self_test=true --disable-verification   check the tool layer in task containers, no model calls
# TBENCH_DATASET overrides the dataset (default terminal-bench/terminal-bench@4.0.0).
#
# Examples:
#   export ANTHROPIC_API_KEY=...
#   scripts/tbench.sh -m anthropic/claude-sonnet-5-5 -i terminal-bench/<task>
#   scripts/tbench.sh -m anthropic/claude-sonnet-5-5 -n 8 --max-retries 2 --retry-include RuntimeError
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
harness=harnesses/tbench/v6
args=()
while [ $# -gt 0 ]; do
	case $1 in
	--harness)
		harness=$2
		shift 2
		;;
	*)
		args+=("$1")
		shift
		;;
	esac
done
case " ${args[*]-} " in
*" -m "* | *" --model "*) ;;
*)
	echo "pass the agent's model: -m provider/model, for example -m anthropic/claude-sonnet-5-5" >&2
	exit 2
	;;
esac
if [ ! -x "$root/.venv-harbor/bin/harbor" ]; then
	echo "Harbor is not installed: run scripts/install.sh tbench" >&2
	exit 1
fi
cd "$root"
PYTHONPATH="$root${PYTHONPATH:+:$PYTHONPATH}" exec .venv-harbor/bin/harbor run \
	-d "${TBENCH_DATASET:-terminal-bench/terminal-bench@4.0.0}" -e docker \
	-a python.tbench.harbor_agent:PiHarnessAgent --ak harness="$harness" ${args[@]+"${args[@]}"}
