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
import tempfile
import tomllib
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.agents.options import AgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import Field

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
MAIN_TS = REPO_ROOT / "src" / "tbench" / "main.ts"
HARBOR_CACHE = pathlib.Path("~/.cache/harbor/tasks").expanduser()
_STREAM_LIMIT = 1 << 30


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
			path = str(message["path"])
			with tempfile.NamedTemporaryFile(delete=False) as handle:
				handle.write(base64.b64decode(message.get("content_b64") or ""))
			try:
				parent = posixpath.dirname(path)
				if parent:
					await self.environment.exec(f"mkdir -p {shlex.quote(parent)}", timeout_sec=60)
				await self.environment.upload_file(handle.name, path)
			finally:
				os.unlink(handle.name)
			return {}
		if op == "download":
			with tempfile.TemporaryDirectory() as tmp:
				target = pathlib.Path(tmp) / "file"
				await self.environment.download_file(str(message["path"]), target)
				return {"content_b64": base64.b64encode(target.read_bytes()).decode()}
		raise ValueError(f"unknown op {op!r}")


class PiHarnessOptions(AgentOptions):
	harness: str = Field(default="harnesses/tbench/v0", description="Harness directory (relative to the repo root).")
	thinking: str | None = Field(default=None, description="Override the harness thinking level.")
	time_budget_sec: float | None = Field(default=None, description="Agent time budget; default: the task timeout.")
	node: str = Field(default="node", description="Node.js executable.")


class PiHarnessAgent(BaseAgent):
	options_model = PiHarnessOptions

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
		config_path = self.logs_dir / "agent-config.json"
		config_path.write_text(json.dumps(config, indent=2))
		env = {**os.environ, "AWS_REGION": os.environ.get("AWS_REGION", "us-east-1")}
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
