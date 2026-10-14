"""Provision Terminal-Bench runner hosts in the test account.

Each host runs Harbor, the task containers (Docker) and the pi harness. Its instance role may only invoke
Bedrock models, IMDSv2 with a hop limit of 1 keeps that role away from task containers, and SSH is open only
to the caller's IP. Every instance is tagged Project=tta-tbench; stop, start and terminate refuse anything else.

Usage (prefix with AWS_PROFILE=<profile>):
  python -m python.tbench.aws_infra setup
  python -m python.tbench.aws_infra launch --label dev --type m7i.8xlarge --disk 1200
  python -m python.tbench.aws_infra list | wait <id> | stop <id> | start <id> | terminate <id> | allow-ip
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import time
import urllib.request
from typing import Any

PROJECT = "tta-tbench"
ROLE_NAME = "tta-tbench-runner"
KEY_NAME = "tta-tbench"
SECURITY_GROUP = "tta-tbench-ssh"
ENDPOINT_GROUP = "tta-tbench-endpoints"
INTERFACE_ENDPOINTS = ["bedrock-runtime", "ssm", "ssmmessages", "ec2messages"]
KEY_PATH = pathlib.Path("~/.ssh/tta-tbench.pem").expanduser()
REPO_URL = "https://github.com/Singh-AP/test-time-adapting-harness.git"
HARBOR_SPEC = "harbor[ec2]==0.24.0"
AMI_PARAMETERS = {
	"cpu": "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
	"gpu": "/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-24.04/latest/ami-id",
}
BOOTSTRAP = pathlib.Path(__file__).with_name("bootstrap.sh")
_SAFE_VALUE = re.compile(r"^[A-Za-z0-9_.:/@\[\]=+~-]+$")


def runner_policy(account: str) -> dict[str, Any]:
	"""Inline policy for the host role: invoke Bedrock models and inference profiles, nothing else."""
	return {
		"Version": "2012-10-17",
		"Statement": [
			{
				"Sid": "InvokeModels",
				"Effect": "Allow",
				"Action": [
					"bedrock:InvokeModel",
					"bedrock:InvokeModelWithResponseStream",
					"bedrock:GetInferenceProfile",
					"bedrock:GetFoundationModel",
				],
				"Resource": [
					"arn:aws:bedrock:*::foundation-model/*",
					f"arn:aws:bedrock:*:{account}:inference-profile/*",
				],
			}
		],
	}


def bucket_name(account: str, region: str) -> str:
	"""Per-region artifact bucket: code bundles in, job results out, through an S3 gateway endpoint."""
	return f"{PROJECT}-{account}-{region}"


def artifact_policy(account: str) -> dict[str, Any]:
	"""Inline policy for the host role: read and write objects in the project's artifact buckets only."""
	return {
		"Version": "2012-10-17",
		"Statement": [
			{
				"Sid": "ProjectArtifacts",
				"Effect": "Allow",
				"Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"],
				"Resource": [f"arn:aws:s3:::{PROJECT}-{account}-*", f"arn:aws:s3:::{PROJECT}-{account}-*/*"],
			}
		],
	}


def trust_policy() -> dict[str, Any]:
	return {
		"Version": "2012-10-17",
		"Statement": [
			{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}
		],
	}


def render_user_data(repo_url: str, repo_ref: str, harbor_spec: str) -> str:
	for value in (repo_url, repo_ref, harbor_spec):
		if not _SAFE_VALUE.match(value):
			raise ValueError(f"unsafe value for user data: {value!r}")
	return (
		BOOTSTRAP.read_text()
		.replace("__REPO_URL__", repo_url)
		.replace("__REPO_REF__", repo_ref)
		.replace("__HARBOR_SPEC__", harbor_spec)
	)


def is_project_instance(instance: dict[str, Any]) -> bool:
	return any(tag["Key"] == "Project" and tag["Value"] == PROJECT for tag in instance.get("Tags", []))


def _tag(instance: dict[str, Any], key: str) -> str:
	return next((tag["Value"] for tag in instance.get("Tags", []) if tag["Key"] == key), "")


class Infra:
	def __init__(self, region: str) -> None:
		import boto3

		self.region = region
		self.session = boto3.Session(region_name=region)
		self.ec2 = self.session.client("ec2")
		self.iam = self.session.client("iam")
		self.ssm = self.session.client("ssm")
		self.account = self.session.client("sts").get_caller_identity()["Account"]

	# --- one-time setup -------------------------------------------------------------------------------------
	def ensure_role(self) -> None:
		iam = self.iam
		try:
			iam.get_role(RoleName=ROLE_NAME)
		except iam.exceptions.NoSuchEntityException:
			iam.create_role(
				RoleName=ROLE_NAME,
				AssumeRolePolicyDocument=json.dumps(trust_policy()),
				Description="Terminal-Bench runner host: invoke Bedrock models only",
				Tags=[{"Key": "Project", "Value": PROJECT}],
			)
			print(f"created role {ROLE_NAME}")
		iam.put_role_policy(
			RoleName=ROLE_NAME, PolicyName="bedrock-invoke", PolicyDocument=json.dumps(runner_policy(self.account))
		)
		try:
			profile = iam.get_instance_profile(InstanceProfileName=ROLE_NAME)["InstanceProfile"]
		except iam.exceptions.NoSuchEntityException:
			profile = iam.create_instance_profile(
				InstanceProfileName=ROLE_NAME, Tags=[{"Key": "Project", "Value": PROJECT}]
			)["InstanceProfile"]
			print(f"created instance profile {ROLE_NAME}")
		if not any(role["RoleName"] == ROLE_NAME for role in profile.get("Roles", [])):
			iam.add_role_to_instance_profile(InstanceProfileName=ROLE_NAME, RoleName=ROLE_NAME)
			print("attached role to instance profile")

	def ensure_key(self) -> None:
		existing = self.ec2.describe_key_pairs(Filters=[{"Name": "key-name", "Values": [KEY_NAME]}])["KeyPairs"]
		if existing and KEY_PATH.exists():
			return
		if existing:
			raise SystemExit(f"key pair {KEY_NAME} exists but {KEY_PATH} is missing; delete the key pair to recreate it")
		if KEY_PATH.exists():
			import subprocess

			public = subprocess.run(["ssh-keygen", "-y", "-f", str(KEY_PATH)], check=True, capture_output=True).stdout
			self.ec2.import_key_pair(
				KeyName=KEY_NAME,
				PublicKeyMaterial=public,
				TagSpecifications=[{"ResourceType": "key-pair", "Tags": [{"Key": "Project", "Value": PROJECT}]}],
			)
			print(f"imported {KEY_PATH} as key pair {KEY_NAME} in {self.region}")
			return
		key = self.ec2.create_key_pair(
			KeyName=KEY_NAME,
			KeyType="ed25519",
			TagSpecifications=[{"ResourceType": "key-pair", "Tags": [{"Key": "Project", "Value": PROJECT}]}],
		)
		KEY_PATH.write_text(key["KeyMaterial"])
		KEY_PATH.chmod(0o600)
		print(f"created key pair {KEY_NAME} -> {KEY_PATH}")

	def default_vpc(self) -> str:
		vpcs = self.ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"]
		if not vpcs:
			raise SystemExit("no default VPC in this region")
		return vpcs[0]["VpcId"]

	def ensure_security_group(self) -> str:
		vpc = self.default_vpc()
		groups = self.ec2.describe_security_groups(
			Filters=[{"Name": "group-name", "Values": [SECURITY_GROUP]}, {"Name": "vpc-id", "Values": [vpc]}]
		)["SecurityGroups"]
		if groups:
			return groups[0]["GroupId"]
		group = self.ec2.create_security_group(
			GroupName=SECURITY_GROUP,
			Description="SSH to Terminal-Bench runner hosts from the operator IP",
			VpcId=vpc,
			TagSpecifications=[{"ResourceType": "security-group", "Tags": [{"Key": "Project", "Value": PROJECT}]}],
		)["GroupId"]
		print(f"created security group {group}")
		return group

	def allow_ip(self, cidr: str | None = None) -> None:
		"""Allow SSH from `cidr`, or from this machine's current egress IP (NATs may use several)."""
		group = self.ensure_security_group()
		if cidr is None:
			ip = urllib.request.urlopen("https://checkip.amazonaws.com", timeout=10).read().decode().strip()
			cidr = f"{ip}/32"
		rules = self.ec2.describe_security_groups(GroupIds=[group])["SecurityGroups"][0]["IpPermissions"]
		if any(r.get("FromPort") == 22 and any(x["CidrIp"] == cidr for x in r.get("IpRanges", [])) for r in rules):
			print(f"{cidr} already allowed")
			return
		self.ec2.authorize_security_group_ingress(
			GroupId=group,
			IpPermissions=[
				{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": cidr, "Description": "operator"}]}
			],
		)
		print(f"allowed SSH from {cidr}")

	# --- private access (works under VPC Block Public Access) ----------------------------------------------------
	def ensure_private_access(self) -> None:
		"""Interface endpoints for Bedrock and SSM, an S3 gateway endpoint, an artifact bucket, and the role permissions
		that go with them, in the subnets of this region's project hosts."""
		s3 = self.session.client("s3")
		bucket = bucket_name(self.account, self.region)
		try:
			s3.head_bucket(Bucket=bucket)
		except s3.exceptions.ClientError:
			kwargs: dict[str, Any] = {"Bucket": bucket}
			if self.region != "us-east-1":
				kwargs["CreateBucketConfiguration"] = {"LocationConstraint": self.region}
			s3.create_bucket(**kwargs)
			print(f"created bucket {bucket}")
		s3.put_public_access_block(
			Bucket=bucket,
			PublicAccessBlockConfiguration={
				"BlockPublicAcls": True,
				"IgnorePublicAcls": True,
				"BlockPublicPolicy": True,
				"RestrictPublicBuckets": True,
			},
		)
		s3.put_bucket_tagging(Bucket=bucket, Tagging={"TagSet": [{"Key": "Project", "Value": PROJECT}]})

		attached = self.iam.list_attached_role_policies(RoleName=ROLE_NAME)["AttachedPolicies"]
		ssm_core = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
		if not any(p["PolicyArn"] == ssm_core for p in attached):
			self.iam.attach_role_policy(RoleName=ROLE_NAME, PolicyArn=ssm_core)
			print("attached AmazonSSMManagedInstanceCore to the host role")
		self.iam.put_role_policy(
			RoleName=ROLE_NAME, PolicyName="project-artifacts", PolicyDocument=json.dumps(artifact_policy(self.account))
		)

		vpc = self.default_vpc()
		cidr = self.ec2.describe_vpcs(VpcIds=[vpc])["Vpcs"][0]["CidrBlock"]
		subnets = sorted({i["SubnetId"] for i in self.instances() if i["State"]["Name"] in ("pending", "running", "stopped")})
		if not subnets:
			raise SystemExit("no project hosts in this region; launch one first")
		groups = self.ec2.describe_security_groups(
			Filters=[{"Name": "group-name", "Values": [ENDPOINT_GROUP]}, {"Name": "vpc-id", "Values": [vpc]}]
		)["SecurityGroups"]
		if groups:
			group = groups[0]["GroupId"]
		else:
			group = self.ec2.create_security_group(
				GroupName=ENDPOINT_GROUP,
				Description="HTTPS from the VPC to interface endpoints for Terminal-Bench hosts",
				VpcId=vpc,
				TagSpecifications=[{"ResourceType": "security-group", "Tags": [{"Key": "Project", "Value": PROJECT}]}],
			)["GroupId"]
			self.ec2.authorize_security_group_ingress(
				GroupId=group, IpPermissions=[{"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [{"CidrIp": cidr}]}]
			)
			print(f"created endpoint security group {group}")
		existing = {
			e["ServiceName"]: e
			for e in self.ec2.describe_vpc_endpoints(Filters=[{"Name": "vpc-id", "Values": [vpc]}])["VpcEndpoints"]
			if e["State"].lower() not in ("deleted", "deleting", "failed", "rejected")
		}
		tags = [{"ResourceType": "vpc-endpoint", "Tags": [{"Key": "Project", "Value": PROJECT}]}]
		for service in INTERFACE_ENDPOINTS:
			name = f"com.amazonaws.{self.region}.{service}"
			endpoint = existing.get(name)
			if endpoint is None:
				created = self.ec2.create_vpc_endpoint(
					VpcEndpointType="Interface",
					VpcId=vpc,
					ServiceName=name,
					SubnetIds=subnets,
					SecurityGroupIds=[group],
					PrivateDnsEnabled=True,
					TagSpecifications=tags,
				)["VpcEndpoint"]
				print(f"created interface endpoint {name} ({created['VpcEndpointId']})")
			elif missing := sorted(set(subnets) - set(endpoint.get("SubnetIds", []))):
				self.ec2.modify_vpc_endpoint(VpcEndpointId=endpoint["VpcEndpointId"], AddSubnetIds=missing)
				print(f"added subnets {missing} to {name}")
		s3_name = f"com.amazonaws.{self.region}.s3"
		if not any(e["ServiceName"] == s3_name and e["VpcEndpointType"] == "Gateway" for e in existing.values()):
			tables = [
				t["RouteTableId"]
				for t in self.ec2.describe_route_tables(Filters=[{"Name": "vpc-id", "Values": [vpc]}])["RouteTables"]
			]
			created = self.ec2.create_vpc_endpoint(
				VpcEndpointType="Gateway", VpcId=vpc, ServiceName=s3_name, RouteTableIds=tables, TagSpecifications=tags
			)["VpcEndpoint"]
			print(f"created gateway endpoint {s3_name} ({created['VpcEndpointId']})")

	# --- hosts ----------------------------------------------------------------------------------------------
	def default_subnets(self, instance_type: str) -> list[str]:
		"""Default-VPC subnets in the availability zones that offer `instance_type`."""
		offered = {
			o["Location"]
			for o in self.ec2.describe_instance_type_offerings(
				LocationType="availability-zone", Filters=[{"Name": "instance-type", "Values": [instance_type]}]
			)["InstanceTypeOfferings"]
		}
		subnets = self.ec2.describe_subnets(
			Filters=[{"Name": "vpc-id", "Values": [self.default_vpc()]}, {"Name": "default-for-az", "Values": ["true"]}]
		)["Subnets"]
		return [n["SubnetId"] for n in sorted(subnets, key=lambda n: n["AvailabilityZone"]) if n["AvailabilityZone"] in offered]

	def launch(self, label: str, instance_type: str, disk_gb: int, flavor: str, repo_ref: str, spot: bool = False) -> str:
		"""Launches in the first availability zone with capacity for `instance_type`."""
		last_error: Exception | None = None
		for subnet in self.default_subnets(instance_type):
			try:
				return self._launch(label, instance_type, disk_gb, flavor, repo_ref, subnet, spot)
			except self.ec2.exceptions.ClientError as error:
				if error.response["Error"]["Code"] not in (
					"InsufficientInstanceCapacity",
					"Unsupported",
					"SpotMaxPriceTooLow",
					"InsufficientCapacity",
				):
					raise
				print(f"no {instance_type} capacity in {subnet}; trying the next zone")
				last_error = error
		raise SystemExit(f"no capacity for {instance_type} in {self.region}: {last_error}")

	def _launch(
		self, label: str, instance_type: str, disk_gb: int, flavor: str, repo_ref: str, subnet: str, spot: bool
	) -> str:
		ami = self.ssm.get_parameter(Name=AMI_PARAMETERS[flavor])["Parameter"]["Value"]
		group = self.ensure_security_group()
		tags = [{"Key": "Project", "Value": PROJECT}, {"Key": "Name", "Value": f"{PROJECT}-{label}"}]
		market = (
			{"InstanceMarketOptions": {"MarketType": "spot", "SpotOptions": {"SpotInstanceType": "one-time"}}}
			if spot
			else {}
		)
		response = self.ec2.run_instances(
			SubnetId=subnet,
			**market,
			ImageId=ami,
			InstanceType=instance_type,
			MinCount=1,
			MaxCount=1,
			KeyName=KEY_NAME,
			SecurityGroupIds=[group],
			IamInstanceProfile={"Name": ROLE_NAME},
			UserData=render_user_data(REPO_URL, repo_ref, HARBOR_SPEC),
			BlockDeviceMappings=[
				{"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": disk_gb, "VolumeType": "gp3", "DeleteOnTermination": True}}
			],
			MetadataOptions={"HttpTokens": "required", "HttpPutResponseHopLimit": 1, "HttpEndpoint": "enabled"},
			TagSpecifications=[{"ResourceType": "instance", "Tags": tags}, {"ResourceType": "volume", "Tags": tags}],
		)
		instance_id = response["Instances"][0]["InstanceId"]
		print(f"launched {instance_id} ({instance_type}, {flavor}, {disk_gb} GB)")
		return instance_id

	def instances(self) -> list[dict[str, Any]]:
		pages = self.ec2.get_paginator("describe_instances").paginate(
			Filters=[{"Name": "tag:Project", "Values": [PROJECT]}]
		)
		return [i for page in pages for r in page["Reservations"] for i in r["Instances"] if is_project_instance(i)]

	def project_instance(self, instance_id: str) -> dict[str, Any]:
		found = [i for i in self.instances() if i["InstanceId"] == instance_id]
		if not found:
			raise SystemExit(f"{instance_id} is not a {PROJECT} instance; refusing")
		return found[0]

	def wait(self, instance_id: str) -> str:
		self.project_instance(instance_id)
		self.ec2.get_waiter("instance_running").wait(InstanceIds=[instance_id])
		for _ in range(60):
			instance = self.project_instance(instance_id)
			if instance.get("PublicIpAddress"):
				return instance["PublicIpAddress"]
			time.sleep(5)
		raise SystemExit(f"{instance_id} has no public IP")


def main(argv: list[str]) -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--region", default="us-east-1")
	sub = parser.add_subparsers(dest="command", required=True)
	sub.add_parser("setup")
	sub.add_parser("allow-ip").add_argument("--cidr", help="CIDR to allow (default: current egress IP /32)")
	sub.add_parser("list")
	sub.add_parser("private-access", help="VPC endpoints, artifact bucket and role permissions (works under BPA)")
	launch = sub.add_parser("launch")
	launch.add_argument("--label", required=True)
	launch.add_argument("--type", default="m7i.8xlarge")
	launch.add_argument("--disk", type=int, default=1200)
	launch.add_argument("--flavor", choices=sorted(AMI_PARAMETERS), default="cpu")
	launch.add_argument("--ref", default="main")
	launch.add_argument("--spot", action="store_true", help="Use spot capacity (cheaper; may be interrupted)")
	for name in ("wait", "stop", "start", "terminate"):
		sub.add_parser(name).add_argument("instance_id")
	args = parser.parse_args(argv)

	infra = Infra(args.region)
	if args.command == "setup":
		infra.ensure_role()
		infra.ensure_key()
		infra.allow_ip()
	elif args.command == "private-access":
		infra.ensure_private_access()
	elif args.command == "allow-ip":
		infra.allow_ip(args.cidr)
	elif args.command == "launch":
		instance_id = infra.launch(args.label, args.type, args.disk, args.flavor, args.ref, args.spot)
		print(f"ssh -i {KEY_PATH} ubuntu@{infra.wait(instance_id)}")
	elif args.command == "wait":
		print(infra.wait(args.instance_id))
	elif args.command == "list":
		for i in infra.instances():
			print(
				i["InstanceId"], i["State"]["Name"], i["InstanceType"], _tag(i, "Name"), i.get("PublicIpAddress", "-")
			)
	elif args.command in ("stop", "start", "terminate"):
		infra.project_instance(args.instance_id)
		action = {"stop": infra.ec2.stop_instances, "start": infra.ec2.start_instances}.get(
			args.command, infra.ec2.terminate_instances
		)
		action(InstanceIds=[args.instance_id])
		print(f"{args.command} requested for {args.instance_id}")


if __name__ == "__main__":
	main(sys.argv[1:])
