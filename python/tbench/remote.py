"""Control runner hosts through SSM and S3 when SSH and GitHub are unreachable (VPC Block Public Access).

Usage (prefix with AWS_PROFILE=<profile>):
  python -m python.tbench.remote run <label> -- <command>     run as ubuntu in a login shell, print the output
  python -m python.tbench.remote deploy <label>               ship the local HEAD as a git bundle and reset to it
  python -m python.tbench.remote results <label> <job>...     copy job results to runs/tbench/<job> through S3

<label> is a host's Name tag without the project prefix (dev, gpu). Hosts are found in every region listed below.
"""

from __future__ import annotations

import pathlib
import shlex
import subprocess
import sys
import time
from typing import Any

from python.tbench.aws_infra import PROJECT, bucket_name

REGIONS = ["us-east-1", "us-east-2", "us-west-2"]
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def as_ubuntu(command: str) -> str:
	return f"sudo -u ubuntu -H bash -lc {shlex.quote(command)}"


def deploy_script(bucket: str, key: str, commit: str) -> str:
	return (
		f"aws s3 cp s3://{bucket}/{key} /tmp/tta-deploy.bundle --only-show-errors && cd ~/tta && "
		f"git fetch -q /tmp/tta-deploy.bundle && git reset -q --hard {commit} && git log --oneline -1"
	)


def push_results_script(bucket: str, job: str) -> str:
	return (
		f"aws s3 sync ~/jobs/{job} s3://{bucket}/jobs/{job} --only-show-errors "
		"--exclude '*/artifacts/*' --exclude '*/.pi/*' --exclude '*.tar' && echo synced"
	)


def find_host(label: str) -> tuple[str, str]:
	"""(instance id, region) of the running project host named <project>-<label>."""
	import boto3

	for region in REGIONS:
		ec2 = boto3.client("ec2", region_name=region)
		reservations = ec2.describe_instances(
			Filters=[
				{"Name": "tag:Project", "Values": [PROJECT]},
				{"Name": "tag:Name", "Values": [f"{PROJECT}-{label}"]},
				{"Name": "instance-state-name", "Values": ["running"]},
			]
		)["Reservations"]
		for reservation in reservations:
			for instance in reservation["Instances"]:
				return instance["InstanceId"], region
	raise SystemExit(f"no running host {PROJECT}-{label}")


def run(label: str, command: str, timeout_sec: int = 3600) -> tuple[int, str]:
	"""Runs `command` on the host through SSM; returns (exit code, full stdout and stderr)."""
	import boto3

	instance, region = find_host(label)
	account = boto3.client("sts").get_caller_identity()["Account"]
	bucket = bucket_name(account, region)
	ssm = boto3.client("ssm", region_name=region)
	command_id = ssm.send_command(
		InstanceIds=[instance],
		DocumentName="AWS-RunShellScript",
		Parameters={"commands": [as_ubuntu(command)], "executionTimeout": [str(timeout_sec)]},
		OutputS3BucketName=bucket,
		OutputS3KeyPrefix="ssm",
		TimeoutSeconds=60,
	)["Command"]["CommandId"]
	result: dict[str, Any] = {}
	for _ in range(timeout_sec // 2 + 60):
		time.sleep(2)
		try:
			result = ssm.get_command_invocation(CommandId=command_id, InstanceId=instance)
		except ssm.exceptions.InvocationDoesNotExist:
			continue
		if result["Status"] not in ("Pending", "InProgress", "Delayed"):
			break
	output = result.get("StandardOutputContent", "") + result.get("StandardErrorContent", "")
	if len(output) >= 24_000:
		s3 = boto3.client("s3", region_name=region)
		parts = []
		prefix = f"ssm/{command_id}/{instance}/"
		for item in s3.list_objects_v2(Bucket=bucket, Prefix=prefix).get("Contents", []):
			parts.append(s3.get_object(Bucket=bucket, Key=item["Key"])["Body"].read().decode(errors="replace"))
		output = "".join(parts) or output
	return int(result.get("ResponseCode", 1)), output


def deploy(label: str) -> None:
	import boto3

	_, region = find_host(label)
	account = boto3.client("sts").get_caller_identity()["Account"]
	bucket = bucket_name(account, region)
	commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, check=True, capture_output=True, text=True).stdout.strip()
	bundle = REPO_ROOT / "runs" / f"deploy-{commit[:12]}.bundle"
	bundle.parent.mkdir(exist_ok=True)
	subprocess.run(["git", "bundle", "create", str(bundle), "HEAD", "main"], cwd=REPO_ROOT, check=True, capture_output=True)
	key = f"code/{commit}.bundle"
	boto3.client("s3", region_name=region).upload_file(str(bundle), bucket, key)
	code, output = run(label, deploy_script(bucket, key, commit), timeout_sec=600)
	print(output.strip())
	if code != 0:
		raise SystemExit(code)


def results(label: str, jobs: list[str]) -> None:
	import boto3

	_, region = find_host(label)
	account = boto3.client("sts").get_caller_identity()["Account"]
	bucket = bucket_name(account, region)
	for job in jobs:
		code, output = run(label, push_results_script(bucket, job), timeout_sec=1800)
		if code != 0:
			raise SystemExit(f"{job}: {output.strip()}")
		target = REPO_ROOT / "runs" / "tbench" / job
		subprocess.run(
			["aws", "s3", "sync", f"s3://{bucket}/jobs/{job}", str(target), "--only-show-errors", "--region", region],
			check=True,
		)
		print(f"synced {job} -> {target}")


def main(argv: list[str]) -> None:
	if len(argv) >= 2 and argv[0] == "run":
		command = " ".join(argv[argv.index("--") + 1 :]) if "--" in argv else " ".join(argv[2:])
		code, output = run(argv[1], command)
		sys.stdout.write(output)
		raise SystemExit(code)
	if len(argv) == 2 and argv[0] == "deploy":
		deploy(argv[1])
		return
	if len(argv) >= 3 and argv[0] == "results":
		results(argv[1], argv[2:])
		return
	raise SystemExit(__doc__)


if __name__ == "__main__":
	main(sys.argv[1:])
