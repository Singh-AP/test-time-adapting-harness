import unittest

from harbor.environments.docker.docker import DockerEnvironment

from python.tbench import harbor_patches


class EgressProbeTests(unittest.TestCase):
	def test_probe_retries_and_caches_success(self):
		calls = []

		def flaky(cls):
			calls.append(1)
			return len(calls) >= 2

		original = DockerEnvironment.__dict__["_egress_control_kernel_support"]
		try:
			DockerEnvironment._egress_control_kernel_support = classmethod(flaky)
			harbor_patches.cache_egress_probe(DockerEnvironment, attempts=3, delay_sec=0)
			self.assertTrue(DockerEnvironment._egress_control_kernel_support())
			self.assertTrue(DockerEnvironment._egress_control_kernel_support())
			self.assertEqual(len(calls), 2)
		finally:
			DockerEnvironment._egress_control_kernel_support = original


if __name__ == "__main__":
	unittest.main()


class VerifierPermissionTests(unittest.TestCase):
	def test_logs_are_handed_to_the_host_user_before_the_reward_is_read(self):
		import asyncio
		from types import SimpleNamespace

		events = []

		class FakeEnv:
			capabilities = SimpleNamespace(mounted=True)

			async def exec(self, command, **kwargs):
				events.append(f"exec {command}")
				return SimpleNamespace(return_code=0)

			async def prepare_logs_for_host(self):
				events.append("chown")

		class FakeVerifier:
			def __init__(self, env):
				self.environment = env

			async def verify(self):
				await self.environment.exec(command="run tests")
				events.append("read reward")
				return "result"

		harbor_patches.hand_logs_to_host_before_reading(FakeVerifier)
		env = FakeEnv()
		self.assertEqual(asyncio.run(FakeVerifier(env).verify()), "result")
		self.assertEqual(events, ["exec run tests", "chown", "read reward"])
		self.assertNotIn("exec", vars(env))
