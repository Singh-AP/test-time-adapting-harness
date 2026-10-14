echo "pwd: $(pwd)   user: $(id -un 2>/dev/null)"
grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null; uname -srm
echo "cpus: $(nproc 2>/dev/null)   $(free -h 2>/dev/null | awk '/Mem:/ {print "memory: " $2 " total, " $7 " available"}')   disk: $(df -h . 2>/dev/null | awk 'NR==2 {print $4 " free"}')"
echo "--- working directory (depth 2)"
find . -maxdepth 2 -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' 2>/dev/null | sort | head -80
echo "--- tools"
for t in python3 pip3 uv conda node npm bun go cargo rustc gcc g++ clang make cmake java mvn ruby perl R julia lean coqc docker git curl wget jq sqlite3 psql; do
	p=$(command -v "$t" 2>/dev/null) && echo "$t: $p $(timeout 5 "$t" --version 2>&1 | head -1 | cut -c1-70)"
done
echo "--- python packages"
timeout 20 python3 -m pip list 2>/dev/null | tail -n +3 | head -60 | awk '{printf "%s==%s ", $1, $2} END {print ""}'
echo "--- network"
if timeout 6 curl -sS -o /dev/null https://pypi.org/simple/ 2>/dev/null; then echo "internet: reachable"; else echo "internet: unreachable"; fi
