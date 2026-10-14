"""Robustness patches for Harbor 0.24.0, applied when Harbor imports python.tbench.harbor_agent.

Harbor's Docker environment probes nftables support by running an alpine container with a hard-coded 30 s
timeout, once for every environment it creates (including each separate verifier environment). Under a heavily
loaded host a single slow probe makes the trial fail with "network_mode='no-network' is not supported". The patch
retries a failed probe and caches the first success for the life of the process.
"""

from __future__ import annotations

import time
from typing import Any


def cache_egress_probe(docker_env_class: Any, attempts: int = 3, delay_sec: float = 5.0) -> None:
	original = docker_env_class.__dict__["_egress_control_kernel_support"].__func__
	state: dict[str, bool] = {}

	def probe(cls: Any) -> bool:
		if state.get("supported"):
			return True
		for attempt in range(attempts):
			if original(cls):
				state["supported"] = True
				return True
			if attempt + 1 < attempts:
				time.sleep(delay_sec)
		return False

	docker_env_class._egress_control_kernel_support = classmethod(probe)


def apply() -> None:
	from harbor.environments.docker.docker import DockerEnvironment

	if not getattr(DockerEnvironment, "_tta_egress_probe_cached", False):
		cache_egress_probe(DockerEnvironment)
		DockerEnvironment._tta_egress_probe_cached = True
