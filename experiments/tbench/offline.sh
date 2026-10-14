#!/bin/bash
# Offline mode for Terminal-Bench on a runner host: containers lose internet access, as under VPC Block Public
# Access. Traffic between a task's containers, and from the host into containers (agent tools, MCP), is unaffected.
# Usage: sudo experiments/tbench/offline.sh on|off|status
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo: iptables needs root" >&2; exit 2; }
ext=$(ip route show default | awk '{print $5; exit}')
rule=(DOCKER-USER -o "$ext" -m comment --comment tta-offline -j DROP)
case "${1:-status}" in
on) iptables -C "${rule[@]}" 2>/dev/null || iptables -I "${rule[@]}"; echo "offline: container egress via $ext dropped" ;;
off) while iptables -C "${rule[@]}" 2>/dev/null; do iptables -D "${rule[@]}"; done; echo "online" ;;
status) if iptables -C "${rule[@]}" 2>/dev/null; then echo "offline"; else echo "online"; fi ;;
esac
