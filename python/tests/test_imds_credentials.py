import unittest

from python.tbench import imds_credentials


class ProcessFormatTests(unittest.TestCase):
	def test_converts_imds_role_credentials_to_credential_process_output(self):
		imds = {
			"Code": "Success",
			"AccessKeyId": "AKIDEXAMPLE",
			"SecretAccessKey": "secret",
			"Token": "token",
			"Expiration": "2026-10-14T20:00:00Z",
		}
		self.assertEqual(
			imds_credentials.to_process_format(imds),
			{
				"Version": 1,
				"AccessKeyId": "AKIDEXAMPLE",
				"SecretAccessKey": "secret",
				"SessionToken": "token",
				"Expiration": "2026-10-14T20:00:00Z",
			},
		)

	def test_rejects_failed_lookups(self):
		with self.assertRaises(RuntimeError):
			imds_credentials.to_process_format({"Code": "AssumeRoleUnauthorizedAccess"})


if __name__ == "__main__":
	unittest.main()
