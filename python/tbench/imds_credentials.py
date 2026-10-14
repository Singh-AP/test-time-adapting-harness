"""AWS SDK credential_process that returns the EC2 instance role's credentials from IMDSv2.

pi's Bedrock auth only recognizes credentials signalled by environment variables or a profile, not the instance
role, so runner hosts use a profile with `credential_process = python3 <this file>`. The SDK calls it again
before the returned Expiration, so long trials keep working. Output goes to the SDK, never to logs.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from typing import Any

IMDS = "http://169.254.169.254/latest"


def to_process_format(imds: dict[str, Any]) -> dict[str, Any]:
	if imds.get("Code") != "Success":
		raise RuntimeError(f"instance role credentials unavailable: {imds.get('Code')}")
	return {
		"Version": 1,
		"AccessKeyId": imds["AccessKeyId"],
		"SecretAccessKey": imds["SecretAccessKey"],
		"SessionToken": imds["Token"],
		"Expiration": imds["Expiration"],
	}


def fetch() -> dict[str, Any]:
	token_request = urllib.request.Request(
		f"{IMDS}/api/token", method="PUT", headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"}
	)
	token = urllib.request.urlopen(token_request, timeout=5).read().decode()
	headers = {"X-aws-ec2-metadata-token": token}

	def get(path: str) -> str:
		return urllib.request.urlopen(urllib.request.Request(f"{IMDS}/meta-data/{path}", headers=headers), timeout=5).read().decode()

	role = get("iam/security-credentials/").split()[0]
	return to_process_format(json.loads(get(f"iam/security-credentials/{role}")))


if __name__ == "__main__":
	try:
		print(json.dumps(fetch()))
	except Exception as error:
		print(f"imds_credentials: {error}", file=sys.stderr)
		sys.exit(1)
