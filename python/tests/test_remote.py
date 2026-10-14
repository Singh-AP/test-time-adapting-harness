import unittest

from python.tbench import remote


class RemoteTests(unittest.TestCase):
	def test_commands_run_as_ubuntu_in_a_login_shell(self):
		wrapped = remote.as_ubuntu("cd ~/tta && echo 'it''s' \"$HOME\"")
		self.assertTrue(wrapped.startswith("sudo -u ubuntu -H bash -lc "))
		self.assertIn("echo", wrapped)

	def test_deploy_script_fetches_the_bundle_and_resets_to_the_commit(self):
		script = remote.deploy_script("tta-tbench-1-us-east-1", "code/abc123.bundle", "abc123")
		self.assertIn("aws s3 cp s3://tta-tbench-1-us-east-1/code/abc123.bundle", script)
		self.assertIn("git fetch -q /tmp/tta-deploy.bundle", script)
		self.assertIn("git reset -q --hard abc123", script)

	def test_results_script_syncs_a_job_to_s3_without_heavy_files(self):
		script = remote.push_results_script("tta-tbench-1-us-east-1", "v1-dev")
		self.assertIn("aws s3 sync ~/jobs/v1-dev s3://tta-tbench-1-us-east-1/jobs/v1-dev", script)
		self.assertIn("--exclude '*/artifacts/*'", script)


if __name__ == "__main__":
	unittest.main()
