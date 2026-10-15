#!/bin/bash
# Installs what the harness needs:
#   - the Node dependencies (Node 22.19 or newer);
#   - .venv-harbor: Python 3.12 with Harbor, the Terminal-Bench runner (running tasks also needs Docker);
#   - .venv: Python 3.12 with reasoning-gym and pyarrow, for the harness-learning tasks.
# Uses uv when it is installed, otherwise python3.12 -m venv and pip.
# Usage: scripts/install.sh [all|tbench|learning]   (default: all)
set -euo pipefail
cd "$(dirname "$0")/.."
what=${1:-all}
case $what in
all | tbench | learning) ;;
*)
	echo "usage: scripts/install.sh [all|tbench|learning]" >&2
	exit 2
	;;
esac

node -e 'const [a, b] = process.versions.node.split(".").map(Number);
if (a < 22 || (a === 22 && b < 19)) { console.error(`Node 22.19 or newer is required, found ${process.versions.node}`); process.exit(1); }'
npm ci --ignore-scripts --no-audit --no-fund

venv() { # <dir> <requirement>...
	local dir=$1
	shift
	if command -v uv >/dev/null 2>&1; then
		uv venv --quiet --allow-existing --python 3.12 "$dir"
		uv pip install --quiet --python "$dir/bin/python" "$@"
	else
		python3.12 -m venv "$dir"
		"$dir/bin/pip" install --quiet "$@"
	fi
}
if [ "$what" != learning ]; then venv .venv-harbor "harbor==0.24.0"; fi
if [ "$what" != tbench ]; then venv .venv "reasoning-gym==0.1.19" "pyarrow==21.0.0"; fi

echo
echo "Installed ($what). Next, make a model reachable and check it, for example:"
echo "  export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY, or AWS credentials for Amazon Bedrock"
echo "  node scripts/check-model.ts anthropic/claude-sonnet-5-5"
