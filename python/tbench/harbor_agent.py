"""Harbor agent that runs the pi harness (src/tbench/main.ts) on the host.

The pi agent and its Bedrock calls stay on the host; its tools run in the task container through Harbor's
environment API, relayed over a JSON-lines bridge on the Node process's stdin and stdout.

Usage:
  harbor run -d terminal-bench/terminal-bench@4.0.0 -e docker \\
    --agent-import-path python.tbench.harbor_agent:PiHarnessAgent -m us.anthropic.claude-opus-5-5 \\
    --ak harness=harnesses/tbench/v0 [--ak thinking=max] [--ak time_budget_sec=1800]
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import posixpath
import shlex
import tomllib
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.options import AgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import Field

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
MAIN_TS = REPO_ROOT / "src" / "tbench" / "main.ts"
HARBOR_CACHE = pathlib.Path("~/.cache/harbor/tasks").expanduser()
_STREAM_LIMIT = 1 << 30
_UPLOAD_CHUNK = 60_000  # base64 characters per exec, a multiple of 4; Linux limits one argument to 128 KiB
_DOWNLOAD_LIMIT = 30 * 1024 * 1024


def bedrock_model_id(model_name: str) -> str:
	return model_name.split("/", 1)[1] if model_name.startswith("amazon-bedrock/") else model_name


def task_timeout_sec(agent_logs_dir: pathlib.Path, cache_root: pathlib.Path = HARBOR_CACHE) -> float | None:
	"""Agent timeout of the trial's task (task.toml [agent].timeout_sec times any multiplier), if it can be found."""
	try:
		config = json.loads((agent_logs_dir.parent / "config.json").read_text())
	except (OSError, ValueError):
		return None
	task = config.get("task") or {}
	candidates = []
	if task.get("path"):
		candidates.append(pathlib.Path(task["path"]) / "task.toml")
	if task.get("name") and task.get("ref"):
		candidates.append(cache_root / "packages" / task["name"] / str(task["ref"]).removeprefix("sha256:") / "task.toml")
	for path in candidates:
		try:
			timeout = tomllib.loads(path.read_text()).get("agent", {}).get("timeout_sec")
		except (OSError, tomllib.TOMLDecodeError):
			continue
		if timeout:
			multiplier = config.get("agent_timeout_multiplier") or config.get("timeout_multiplier") or 1
			return float(timeout) * float(multiplier)
	return None


class BridgeServer:
	"""Serves one agent process: runs its exec/upload/download requests in the environment."""

	def __init__(self, environment: BaseEnvironment, process: asyncio.subprocess.Process, context: AgentContext):
		self.environment = environment
		self.process = process
		self.context = context
		self._write_lock = asyncio.Lock()
		self.done: dict[str, Any] | None = None

	async def serve(self) -> dict[str, Any] | None:
		assert self.process.stdout is not None
		tasks: set[asyncio.Task[None]] = set()
		try:
			while True:
				line = await self.process.stdout.readline()
				if not line:
					break
				try:
					message = json.loads(line)
				except ValueError:
					continue
				if not isinstance(message, dict):
					continue
				if message.get("kind") == "request":
					task = asyncio.create_task(self._handle(message))
					tasks.add(task)
					task.add_done_callback(tasks.discard)
				elif message.get("kind") == "event":
					self._on_event(message)
		finally:
			for task in tasks:
				task.cancel()
		return self.done

	def _on_event(self, message: dict[str, Any]) -> None:
		event = message.get("event")
		if event in ("usage", "done"):
			self._apply_usage(message)
		if event == "done":
			self.done = message
			metadata = dict(self.context.metadata or {})
			metadata.update(
				stop_reason=message.get("stopReason"),
				finish_checks=message.get("finishChecks"),
				errors=message.get("errors"),
				elapsed_sec=message.get("elapsedSec"),
			)
			self.context.metadata = metadata

	def _apply_usage(self, usage: dict[str, Any]) -> None:
		cache_read = int(usage.get("cacheRead") or 0)
		self.context.n_input_tokens = int(usage.get("input") or 0) + cache_read + int(usage.get("cacheWrite") or 0)
		self.context.n_cache_tokens = cache_read
		self.context.n_output_tokens = int(usage.get("output") or 0)
		self.context.cost_usd = float(usage.get("cost") or 0.0)
		metadata = dict(self.context.metadata or {})
		metadata.update(turns=usage.get("turns"), tool_calls=usage.get("toolCalls"))
		self.context.metadata = metadata

	async def _handle(self, message: dict[str, Any]) -> None:
		try:
			result = await self._dispatch(message)
			reply = {"kind": "response", "id": message.get("id"), "ok": True, "result": result}
		except Exception as error:  # reported to the agent as a failed tool operation
			reply = {"kind": "response", "id": message.get("id"), "ok": False, "error": f"{type(error).__name__}: {error}"}
		async with self._write_lock:
			assert self.process.stdin is not None
			self.process.stdin.write((json.dumps(reply) + "\n").encode())
			await self.process.stdin.drain()

	async def _dispatch(self, message: dict[str, Any]) -> dict[str, Any]:
		op = message.get("op")
		if op == "exec":
			timeout = message.get("timeout_sec")
			r = await self.environment.exec(str(message["command"]), timeout_sec=int(timeout) if timeout else None)
			return {"stdout": r.stdout or "", "stderr": r.stderr or "", "return_code": r.return_code}
		if op == "upload":
			await self._upload(str(message["path"]), str(message.get("content_b64") or ""))
			return {}
		if op == "download":
			return {"content_b64": await self._download(str(message["path"]))}
		raise ValueError(f"unknown op {op!r}")


	# Files move through exec as the task's default user, not docker cp: docker cp writes root-owned files with the
	# temp file's 0600 mode (unreadable for non-root task users) and cannot write into tmpfs mounts.
	async def _upload(self, path: str, data_b64: str) -> None:
		quoted = shlex.quote(path)
		parent = posixpath.dirname(path)
		prefix = f"mkdir -p {shlex.quote(parent)} && " if parent else ""
		chunks = [data_b64[i : i + _UPLOAD_CHUNK] for i in range(0, len(data_b64), _UPLOAD_CHUNK)] or [""]
		for index, chunk in enumerate(chunks):
			redirect = ">" if index == 0 else ">>"
			command = f"printf '%s' '{chunk}' | base64 -d {redirect} {quoted}" if chunk else f": > {quoted}"
			r = await self.environment.exec((prefix if index == 0 else "") + command, timeout_sec=120)
			if r.return_code != 0:
				raise OSError(f"cannot write {path}: {(r.stdout or '') + (r.stderr or '')}".strip())

	async def _download(self, path: str) -> str:
		quoted = shlex.quote(path)
		command = (
			f"if [ -d {quoted} ]; then echo __TTA_ISDIR__; exit 3; fi; "
			f"if [ ! -r {quoted} ]; then echo __TTA_NOFILE__; exit 3; fi; "
			f"size=$(wc -c < {quoted}); if [ \"$size\" -gt {_DOWNLOAD_LIMIT} ]; then echo __TTA_TOOBIG__ $size; exit 4; fi; "
			f"printf '__TTA_B64_START__'; base64 < {quoted} | tr -d '\\n'; printf '__TTA_B64_END__'"
		)
		r = await self.environment.exec(command, timeout_sec=300)
		out = (r.stdout or "") + (r.stderr or "")
		if "__TTA_ISDIR__" in out:
			raise IsADirectoryError(f"{path} is a directory")
		if "__TTA_NOFILE__" in out:
			raise FileNotFoundError(f"no such file or not readable: {path}")
		if "__TTA_TOOBIG__" in out:
			raise OSError(f"{path} is larger than {_DOWNLOAD_LIMIT} bytes; inspect it with bash (head, sed, grep)")
		start, end = out.find("__TTA_B64_START__"), out.find("__TTA_B64_END__")
		if r.return_code != 0 or start < 0 or end < start:
			raise OSError(f"cannot read {path}: {out[:500]}")
		return out[start + len("__TTA_B64_START__") : end]


class PiHarnessOptions(AgentOptions):
	harness: str = Field(default="harnesses/tbench/v0", description="Harness directory (relative to the repo root).")
	thinking: str | None = Field(default=None, description="Override the harness thinking level.")
	time_budget_sec: float | None = Field(default=None, description="Agent time budget; default: the task timeout.")
	node: str = Field(default="node", description="Node.js executable.")
	self_test: bool = Field(default=False, description="Exercise the tool layer in the container, no model calls.")
	aws_profile: str = Field(
		default="tta-instance", description="AWS profile for Bedrock when AWS_PROFILE is unset (runner hosts)."
	)


class PiHarnessAgent(BaseAgent):
	options_model = PiHarnessOptions
	capabilities = AgentCapabilities(skills=True, mcp_servers=True)

	@staticmethod
	def name() -> str:
		return "tta-pi-harness"

	def version(self) -> str | None:
		return "0.1.0"

	async def setup(self, environment: BaseEnvironment) -> None:
		return None

	async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
		options: PiHarnessOptions = self.options  # type: ignore[assignment]
		harness = pathlib.Path(options.harness)
		harness = harness if harness.is_absolute() else REPO_ROOT / harness
		budget = options.time_budget_sec or task_timeout_sec(self.logs_dir) or 1800.0
		self.logs_dir.mkdir(parents=True, exist_ok=True)
		config = {
			"instruction": instruction,
			"modelId": bedrock_model_id(self.model_name or "us.anthropic.claude-opus-5-5"),
			"harnessDir": str(harness),
			"timeBudgetSec": budget,
			"logsDir": str(self.logs_dir),
		}
		if options.thinking:
			config["thinkingLevel"] = options.thinking
		if options.self_test:
			config["selfTest"] = True
		if self.skills_dir:
			config["skillsDir"] = self.skills_dir
		if self.mcp_servers:
			config["mcpServers"] = [server.model_dump(mode="json") for server in self.mcp_servers]
		config_path = self.logs_dir / "agent-config.json"
		config_path.write_text(json.dumps(config, indent=2))
		env = {**os.environ, "AWS_REGION": os.environ.get("AWS_REGION", "us-east-1")}
		env.setdefault("AWS_PROFILE", options.aws_profile)
		with open(self.logs_dir / "agent-stderr.log", "ab") as stderr:
			process = await asyncio.create_subprocess_exec(
				options.node,
				str(MAIN_TS),
				str(config_path),
				stdin=asyncio.subprocess.PIPE,
				stdout=asyncio.subprocess.PIPE,
				stderr=stderr,
				cwd=str(REPO_ROOT),
				env=env,
				limit=_STREAM_LIMIT,
			)
			try:
				await BridgeServer(environment, process, context).serve()
				await process.wait()
			finally:
				if process.returncode is None:
					process.kill()
					await process.wait()
