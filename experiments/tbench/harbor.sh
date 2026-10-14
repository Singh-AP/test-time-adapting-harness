#!/bin/bash
# Harbor with this repo's robustness patches applied (python/tbench/harbor_patches.py), for runs whose agent is
# not ours (for example the oracle). Usage: experiments/tbench/harbor.sh run -d ... -a oracle ...
cd "$(dirname "$0")/../.."
PYTHONPATH="$PWD" exec .venv-harbor/bin/python -c 'import sys
from python.tbench import harbor_patches
harbor_patches.apply()
from harbor.cli.main import app
sys.argv = ["harbor"] + sys.argv[1:]
app()' "$@"
