import unittest

from python.tbench import aws_infra


class PolicyTests(unittest.TestCase):
	def test_runner_policy_allows_only_bedrock_invocation(self):
		policy = aws_infra.runner_policy("123456789012")
		actions = {action for statement in policy["Statement"] for action in statement["Action"]}
		self.assertTrue(all(action.startswith("bedrock:") for action in actions))
		self.assertIn("bedrock:InvokeModel", actions)
		self.assertIn("bedrock:InvokeModelWithResponseStream", actions)
		resources = {resource for statement in policy["Statement"] for resource in statement["Resource"]}
		self.assertIn("arn:aws:bedrock:*::foundation-model/*", resources)
		self.assertIn("arn:aws:bedrock:*:123456789012:inference-profile/*", resources)

	def test_trust_policy_is_for_ec2_only(self):
		policy = aws_infra.trust_policy()
		(statement,) = policy["Statement"]
		self.assertEqual(statement["Principal"], {"Service": "ec2.amazonaws.com"})
		self.assertEqual(statement["Action"], "sts:AssumeRole")


class UserDataTests(unittest.TestCase):
	def test_placeholders_are_replaced(self):
		script = aws_infra.render_user_data("https://example.com/repo.git", "abc123", "harbor[ec2]==0.24.0")
		self.assertIn('REPO_URL="https://example.com/repo.git"', script)
		self.assertIn('REPO_REF="abc123"', script)
		self.assertIn('HARBOR_SPEC="harbor[ec2]==0.24.0"', script)
		self.assertNotIn("__", script.split("set -euxo pipefail", 1)[1].split("apt-get", 1)[0])

	def test_rejects_values_that_break_quoting(self):
		with self.assertRaises(ValueError):
			aws_infra.render_user_data('https://example.com/"; rm -rf /', "main", "harbor")


class SafetyTests(unittest.TestCase):
	def test_only_project_instances_are_managed(self):
		ours = {"InstanceId": "i-1", "Tags": [{"Key": "Project", "Value": aws_infra.PROJECT}]}
		theirs = {"InstanceId": "i-2", "Tags": [{"Key": "Project", "Value": "other"}]}
		untagged = {"InstanceId": "i-3"}
		self.assertTrue(aws_infra.is_project_instance(ours))
		self.assertFalse(aws_infra.is_project_instance(theirs))
		self.assertFalse(aws_infra.is_project_instance(untagged))


if __name__ == "__main__":
	unittest.main()
