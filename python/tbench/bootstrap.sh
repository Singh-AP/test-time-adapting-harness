#!/bin/bash
# cloud-init user data for a Terminal-Bench runner host (Ubuntu 24.04, x86_64).
# Installs Docker, Node 22, uv, Harbor and this repository, then touches /var/lib/tta-bootstrap-done.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
REPO_URL="__REPO_URL__"
REPO_REF="__REPO_REF__"
HARBOR_SPEC="__HARBOR_SPEC__"

apt-get update
apt-get install -y ca-certificates curl git jq tmux build-essential unzip rsync python3-venv

# Docker from Docker's apt repository (compose plugin included). The GPU AMI already ships Docker.
if ! command -v docker >/dev/null 2>&1; then
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
	apt-get update
	apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Many concurrent trials each create a compose network; widen the address pool and rotate logs.
mkdir -p /etc/docker
python3 - <<'PY'
import json, pathlib
path = pathlib.Path("/etc/docker/daemon.json")
config = json.loads(path.read_text()) if path.exists() else {}
config.update({
	"default-address-pools": [{"base": "10.200.0.0/14", "size": 24}],
	"log-driver": "json-file",
	"log-opts": {"max-size": "50m", "max-file": "3"},
	"max-concurrent-downloads": 8,
})
path.write_text(json.dumps(config, indent=2))
PY
systemctl enable docker
systemctl restart docker
usermod -aG docker ubuntu

cat > /etc/security/limits.d/90-tta.conf <<'LIMITS'
* soft nofile 1048576
* hard nofile 1048576
LIMITS
sysctl -w fs.inotify.max_user_instances=8192 fs.inotify.max_user_watches=1048576

if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q '^v2[2-9]'; then
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -y nodejs
fi
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

sudo -u ubuntu -H bash -lc "
	set -euxo pipefail
	git clone '$REPO_URL' ~/tta
	cd ~/tta
	git checkout '$REPO_REF'
	npm install --ignore-scripts
	uv venv -q --python 3.12 .venv-harbor
	uv pip install -q --python .venv-harbor/bin/python '$HARBOR_SPEC'
"
touch /var/lib/tta-bootstrap-done
