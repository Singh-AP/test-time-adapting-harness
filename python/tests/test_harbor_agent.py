import asyncio
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from python.tbench import harbor_agent

FAKE_AGENT = textwrap.dedent(
	"""
	import base64, json, sys
	def call(op, **payload):
	    call.n = getattr(call, "n", 0) + 1
	    print(json.dumps({"kind": "request", "id": call.n, "op": op, **payload}), flush=True)
	    while True:
	        message = json.loads(sys.stdin.readline())
	        if message.get("id") == call.n:
	            return message
	print("not json noise from a library", flush=True)
	r = call("exec", command="echo hi && echo oops >&2", timeout_sec=30)
	up = call("upload", path="/work/sub/a.txt", content_b64=base64.b64encode(b"data").decode())
	down = call("download", path="/work/sub/a.txt")
	missing = call("download", path="/work/none.txt")
	print(json.dumps({"kind": "event", "event": "usage", "turns": 2, "toolCalls": 3, "input": 100, "output": 20,
	                  "cacheRead": 50, "cacheWrite": 10, "cost": 0.5}), flush=True)
	print(json.dumps({"kind": "event", "event": "done", "stopReason": "completed",
	                  "exec": r["result"], "down": base64.b64decode(down["result"]["content_b64"]).decode(),
	                  "upload_ok": up["ok"], "missing_ok": missing["ok"], "turns": 2, "toolCalls": 3, "input": 100,
	                  "output": 20, "cacheRead": 50, "cacheWrite": 10, "cost": 0.5}), flush=True)
	"""
)


class FakeEnvironment:
	"""Maps container paths under /work to a temp dir and runs commands with local bash."""

	def __init__(self, root: pathlib.Path):
		self.root = root

	def _local(self, path: str) -> pathlib.Path:
		return self.root / path.lstrip("/")

	async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
		command = command.replace("/work", str(self.root / "work"))
		proc = subprocess.run(["bash", "-c", command], capture_output=True, text=True, timeout=timeout_sec)
		return ExecResult(stdout=proc.stdout, stderr=proc.stderr, return_code=proc.returncode)

	async def upload_file(self, source_path, target_path):
		target = self._local(target_path)
		target.parent.mkdir(parents=True, exist_ok=True)
		shutil.copy(source_path, target)

	async def download_file(self, source_path, target_path):
		source = self._local(source_path)
		if not source.exists():
			raise FileNotFoundError(source_path)
		shutil.copy(source, target_path)


class BridgeServerTests(unittest.TestCase):
	def test_serves_requests_and_tracks_usage(self):
		async def scenario():
			with tempfile.TemporaryDirectory() as tmp:
				root = pathlib.Path(tmp)
				script = root / "fake_agent.py"
				script.write_text(FAKE_AGENT)
				proc = await asyncio.create_subprocess_exec(
					sys.executable, str(script), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE
				)
				context = AgentContext()
				done = await harbor_agent.BridgeServer(FakeEnvironment(root), proc, context).serve()
				await proc.wait()
				return done, context

		done, context = asyncio.run(scenario())
		self.assertEqual(done["exec"]["stdout"], "hi\n")
		self.assertEqual(done["exec"]["stderr"], "oops\n")
		self.assertEqual(done["exec"]["return_code"], 0)
		self.assertTrue(done["upload_ok"])
		self.assertEqual(done["down"], "data")
		self.assertFalse(done["missing_ok"])
		self.assertEqual(context.n_input_tokens, 160)
		self.assertEqual(context.n_cache_tokens, 50)
		self.assertEqual(context.n_output_tokens, 20)
		self.assertEqual(context.cost_usd, 0.5)
		self.assertEqual(context.metadata["stop_reason"], "completed")


class TimeoutTests(unittest.TestCase):
	def test_reads_the_agent_timeout_of_a_cached_registry_task(self):
		with tempfile.TemporaryDirectory() as tmp:
			root = pathlib.Path(tmp)
			cache = root / "cache" / "packages" / "terminal-bench" / "demo" / "abc123"
			cache.mkdir(parents=True)
			(cache / "task.toml").write_text("[agent]\ntimeout_sec = 900.0\n")
			trial = root / "jobs" / "job" / "demo__x"
			(trial / "agent").mkdir(parents=True)
			(trial / "config.json").write_text(
				json.dumps({"task": {"name": "terminal-bench/demo", "ref": "sha256:abc123"}, "agent_timeout_multiplier": 2})
			)
			self.assertEqual(harbor_agent.task_timeout_sec(trial / "agent", cache_root=root / "cache"), 1800.0)

	def test_reads_the_timeout_of_a_local_task_path(self):
		with tempfile.TemporaryDirectory() as tmp:
			root = pathlib.Path(tmp)
			(root / "task").mkdir()
			(root / "task" / "task.toml").write_text("[agent]\ntimeout_sec = 120\n")
			trial = root / "trial"
			(trial / "agent").mkdir(parents=True)
			(trial / "config.json").write_text(json.dumps({"task": {"path": str(root / "task")}}))
			self.assertEqual(harbor_agent.task_timeout_sec(trial / "agent", cache_root=root / "none"), 120.0)

	def test_unknown_task_gives_none(self):
		with tempfile.TemporaryDirectory() as tmp:
			self.assertIsNone(harbor_agent.task_timeout_sec(pathlib.Path(tmp) / "agent"))


class ModelIdTests(unittest.TestCase):
	def test_strips_provider_prefix(self):
		self.assertEqual(harbor_agent.bedrock_model_id("amazon-bedrock/us.anthropic.claude-opus-5-5"), "us.anthropic.claude-opus-5-5")
		self.assertEqual(harbor_agent.bedrock_model_id("us.anthropic.claude-opus-5-5"), "us.anthropic.claude-opus-5-5")


if __name__ == "__main__":
	unittest.main()
