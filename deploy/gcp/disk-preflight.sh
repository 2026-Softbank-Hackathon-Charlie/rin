#!/usr/bin/env bash
# Shared EC2/GCP pre-pull check. Never delete a container, volume or workspace.
set -euo pipefail
image="${1:?usage: disk-preflight.sh <image>}"
dir=/srv/rin
docker_root="$(docker info --format '{{.DockerRootDir}}')"
[ -n "$docker_root" ] || { echo 'cannot determine Docker data directory' >&2; exit 1; }

# Preserve all container references (including draining workers/sandboxes), both
# successful releases and the requested image if it is already available locally.
declare -A keep=()
containers="$(docker ps -aq)"
while IFS= read -r container; do
  [ -n "$container" ] || continue
  id="$(docker inspect --format '{{.Image}}' "$container")"
  keep["$id"]=1
done <<< "$containers"
for release in "$dir/current-image" "$dir/previous-image"; do
  if [ -s "$release" ]; then
    id="$(docker image inspect --format '{{.Id}}' "$(cat "$release")")"
    keep["$id"]=1
  fi
done
if id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)"; then keep["$id"]=1; fi

# Limit collection to this application's tagged images. Docker refuses removal
# of a newly referenced image, so a concurrent sandbox start remains safe.
images="$(docker image ls --format '{{.ID}} {{.Repository}}' --no-trunc)"
while read -r id repository; do
  case "$repository" in */hopcharlie/rin)
    if [ -z "${keep[$id]:-}" ]; then docker image rm "$id" >/dev/null || true; fi ;;
  esac
done <<< "$images"

# Reserve 8 GiB for image extraction and database/workspace growth on a 40 GiB host.
# Failure is deliberately before pull, Compose or any old-service mutation.
available_kb="$(df -k --output=avail "$docker_root" | tail -n 1 | tr -d ' ')"
if ! [[ "$available_kb" =~ ^[0-9]+$ ]] || [ "$available_kb" -lt 8388608 ]; then
  echo 'insufficient Docker disk space: require at least 8 GiB available before pull' >&2
  exit 1
fi
