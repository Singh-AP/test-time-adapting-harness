#!/bin/bash
# Usage: experiments/tbench/wait.sh <host> <minutes> <job>=<count>...  exits when every job has at least <count> verified trials.
host=$1; minutes=$2; shift 2
for _ in $(seq 1 $((minutes / 2))); do
	ok=1; status=""
	for spec in "$@"; do
		job=${spec%=*}; want=${spec#*=}
		have=$(ssh -i ~/.ssh/tta-tbench.pem -o ConnectTimeout=20 ubuntu@$host "ls ~/jobs/$job/*__*/result.json 2>/dev/null | wc -l" 2>/dev/null || echo 0)
		status="$status $job=$have"
		[ "${have:-0}" -ge "$want" ] || ok=0
	done
	if [ $ok -eq 1 ]; then echo "reached:$status"; exit 0; fi
	sleep 120
done
echo "timeout:$status"
