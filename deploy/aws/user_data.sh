#!/bin/bash
# First boot of the Rin host (runs once). Installs Docker and the Compose
# plugin and creates the data directories. Everything else arrives with each
# deploy (.github/workflows/deploy.yml runs deploy/ec2/deploy.sh through SSM).
# Log: /var/log/rin-bootstrap.log
set -euo pipefail
exec > >(tee -a /var/log/rin-bootstrap.log) 2>&1

dnf install -y docker
systemctl enable --now docker
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/download/v5.6.1/docker-compose-linux-x86_64
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

# The worker runs as node (uid 1000) and writes /data.
mkdir -p /srv/rin/data /srv/rin/pg
chown 1000:1000 /srv/rin/data
echo "bootstrap done"
