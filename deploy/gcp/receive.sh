#!/usr/bin/env bash
# Runs as root over IAP. stdin is a tar archive, never a shell program or CLI secret.
set +x
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo 'root is required' >&2; exit 1; }
marker=/srv/rin/.migration-ready
if [ ! -f "$marker" ] || [ -L "$marker" ] || [ "$(stat -c %u "$marker")" != 0 ]; then
  echo 'missing root-owned /srv/rin/.migration-ready; restore and verify data before deployment' >&2
  exit 1
fi
stage="$(mktemp -d /run/rin-deploy.XXXXXX)"
cid=""
cleanup() {
  if [ -n "$cid" ]; then docker rm "$cid" >/dev/null 2>&1 || true; fi
  rm -f /run/rin.env
  rm -rf -- "$stage"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
# Only these fixed names are extracted; no archive path can choose a host path.
tar -xf - -C "$stage" --no-same-owner --no-same-permissions \
  rin.env ecr-password image disk-preflight.sh
for name in rin.env ecr-password image disk-preflight.sh; do
  file="$stage/$name"
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c %h "$file")" = 1 ] || {
    echo 'invalid deployment payload' >&2; exit 1;
  }
  chmod 600 "$file"
done
IFS= read -r image < "$stage/image"
[[ "$image" =~ ^[0-9]{12}\.dkr\.ecr\.ap-northeast-2\.amazonaws\.com/hopcharlie/rin:[a-f0-9]{40}$ ]] || {
  echo 'invalid Rin image reference' >&2; exit 1;
}
bash "$stage/disk-preflight.sh" "$image"
export HOME=/root DOCKER_CONFIG="$stage/docker"
mkdir -m 700 "$DOCKER_CONFIG"
docker login --username AWS --password-stdin "${image%%/*}" < "$stage/ecr-password" >/dev/null
rm -f "$stage/ecr-password"
docker pull -q "$image"
# Drop even the pull-only registry token before starting application containers.
rm -rf -- "$DOCKER_CONFIG"
cid="$(docker create "$image")"
docker cp "$cid:/app/deploy/ec2/deploy.sh" /srv/rin/deploy.sh
docker cp "$cid:/app/deploy/compose.db.yaml" /srv/rin/compose.db.yaml
docker cp "$cid:/app/deploy/compose.app.yaml" /srv/rin/compose.app.yaml
docker rm "$cid" >/dev/null
cid=""
RIN_ENV_FILE="$stage/rin.env" bash /srv/rin/deploy.sh "$image"
