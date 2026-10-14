#!/bin/bash
# Copy Harbor job results from a runner host into runs/tbench/<job>/ (git-ignored).
# Usage: experiments/tbench/sync.sh <host-ip> <job-name>...
set -euo pipefail
cd "$(dirname "$0")/../.."
host=$1
shift
for job in "$@"; do
	mkdir -p "runs/tbench/$job"
	rsync -az -e "ssh -i $HOME/.ssh/tta-tbench.pem -o StrictHostKeyChecking=accept-new" \
		--exclude '*/artifacts/**' --exclude '.pi/' --exclude '*.tar' --max-size=20m \
		"ubuntu@$host:jobs/$job/" "runs/tbench/$job/"
	echo "synced $job"
done
