"""Robustness patches for Harbor 0.24.0, applied when Harbor imports python.tbench.harbor_agent.

Harbor's Docker environment probes nftables support by running an alpine container with a hard-coded 30 s
timeout, once for every environment it creates (including each separate verifier environment). Under a heavily
loaded host a single slow probe makes the trial fail with "network_mode='no-network' is not supported". The patch
retries a failed probe and caches the first success for the life of the process.

Harbor also hands bind-mounted log directories back to the host user only when an environment stops, after the
verifier has read the reward. A verifier running as another user can leave its log directory unreadable
(fp8-rmsnorm-gemm: PermissionError on verifier/reward.json although the tests passed). The second patch runs
prepare_logs_for_host() after each verifier command, before the reward is read.
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


def hand_logs_to_host_before_reading(verifier_class: Any) -> None:
	original = verifier_class.verify

	async def verify(self: Any, *args: Any, **kwargs: Any) -> Any:
		env = self.environment
		prepare = getattr(env, "prepare_logs_for_host", None)
		if prepare is None or not getattr(getattr(env, "capabilities", None), "mounted", False):
			return await original(self, *args, **kwargs)
		original_exec = env.exec
		handing_back = False

		async def exec_then_hand_back(*exec_args: Any, **exec_kwargs: Any) -> Any:
			nonlocal handing_back
			if handing_back:  # prepare_logs_for_host chowns through exec itself
				return await original_exec(*exec_args, **exec_kwargs)
			try:
				return await original_exec(*exec_args, **exec_kwargs)
			finally:
				handing_back = True
				try:
					await prepare()
				finally:
					handing_back = False

		env.exec = exec_then_hand_back
		try:
			return await original(self, *args, **kwargs)
		finally:
			del env.exec

	verifier_class.verify = verify


def apply() -> None:
	from harbor.environments.docker.docker import DockerEnvironment
	from harbor.verifier.verifier import Verifier

	if not getattr(DockerEnvironment, "_tta_egress_probe_cached", False):
		cache_egress_probe(DockerEnvironment)
		DockerEnvironment._tta_egress_probe_cached = True
	if not getattr(Verifier, "_tta_logs_handed_back", False):
		hand_logs_to_host_before_reading(Verifier)
		Verifier._tta_logs_handed_back = True
