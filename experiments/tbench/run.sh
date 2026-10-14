#!/bin/bash
# Run the pi harness on Terminal-Bench 4.0 tasks on a runner host (python/tbench/aws_infra.py).
# Usage: experiments/tbench/run.sh <job-name> <harness-dir> <model-id> <dev|heldout|all> <gpu: include|exclude|only> <n-concurrent> [harbor args...]
# Set TTA_OFFLINE=1 to run only the offline-solvable tasks (the host must be in offline mode: sudo experiments/tbench/offline.sh on).
# Example: experiments/tbench/run.sh v0-sonnet harnesses/tbench/v0 global.anthropic.claude-sonnet-5-5 all exclude 40
set -euo pipefail
cd "$(dirname "$0")/../.."
job=$1 harness=$2 model=$3 subset=$4 gpu=$5 n=$6
shift 6
offline_flag=""
if [ "${TTA_OFFLINE:-0}" = 1 ]; then
	offline_flag=--offline
	sudo -n experiments/tbench/offline.sh status | grep -qx offline || { echo "TTA_OFFLINE=1 but the host is online" >&2; exit 2; }
fi
read -r -a filters <<< "$(python3 experiments/tbench/split.py select experiments/tbench/splits/tb4.json "$subset" --gpu "$gpu" $offline_flag)"
ulimit -n 65536 2>/dev/null || true
# Bedrock calls go to this host's region (a VPC endpoint under Block Public Access).
if [ -z "${AWS_REGION:-}" ]; then
	token=$(curl -s -m 2 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token || true)
	AWS_REGION=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region || true)
	export AWS_REGION=${AWS_REGION:-us-east-1}
fi
git rev-parse --short HEAD > "$HOME/jobs/$job.commit" 2>/dev/null || true
PYTHONPATH="$PWD" exec .venv-harbor/bin/harbor run -d terminal-bench/terminal-bench@4.0.0 -e docker \
	-a python.tbench.harbor_agent:PiHarnessAgent -m "$model" --ak harness="$harness" \
	"${filters[@]}" -n "$n" -o "$HOME/jobs" --job-name "$job" -y "$@"
