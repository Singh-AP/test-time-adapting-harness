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
