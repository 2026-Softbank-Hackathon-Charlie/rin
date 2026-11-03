#!/usr/bin/env bash
# Hands Rin over to a new image on the EC2 host without cutting running work.
#   bash /srv/rin/deploy.sh <image>
# Runs as root through SSM Run Command (.github/workflows/deploy.yml), after the workflow
# has pulled <image> and copied this file, deploy/compose.db.yaml and deploy/compose.app.yaml
# out of it into /srv/rin.
#
# 1. Postgres keeps running as compose project "rin" (compose.db.yaml).
# 2. The new gateway and worker start next to the running ones as project rin-<short sha>.
# 3. If they do not become healthy they are removed. The running version never noticed,
#    so this is the whole rollback.
# 4. Once healthy, old gateways are removed. Socket Mode accepts several connections and
#    gives each event to one of them, so no mention is lost during the overlap.
# 5. Old workers get SIGTERM and will not restart: they take no new jobs, finish the ones
#    they run (up to 2 hours) and exit on their own. The workers share one concurrency
#    limit through the database, so the overlap never runs more Claude sessions than usual.
set -euo pipefail

image="${1:?usage: deploy.sh <image>}"
region=ap-northeast-2
dir=/srv/rin
env_file=/run/rin.env
health_timeout=180
tag="${image##*:}"
version="${tag:0:7}"
project="rin-$version"

db() { # <docker compose arguments...>
  docker compose -p rin -f "$dir/compose.db.yaml" --env-file "$env_file" "$@"
}

app() { # <docker compose arguments...> for the new version
  # The worker joins the group that owns the Docker socket to start sandbox containers.
  RIN_IMAGE="$image" RIN_VERSION="$version" DOCKER_GID="$(stat -c %g /var/run/docker.sock)" \
    docker compose -p "$project" -f "$dir/compose.app.yaml" --env-file "$env_file" "$@"
}

# Every /rin/<KEY> parameter becomes KEY=VALUE. /run is tmpfs, so the secrets
# never reach the disk; running containers keep their environment on reboot.
write_env() {
  local tmp name value
  tmp="$(mktemp /run/rin.env.XXXXXX)"
  chmod 600 "$tmp"
  aws ssm get-parameters-by-path --region "$region" --path /rin --with-decryption \
    --query 'Parameters[].[Name,Value]' --output text |
    while IFS=$'\t' read -r name value; do
      printf '%s=%s\n' "${name#/rin/}" "$value"
    done > "$tmp"
  mv -f "$tmp" "$env_file"
}

# Waits up to $health_timeout seconds for the services to be healthy.
wait_healthy() { # <db|app> <service...>
  local fn="$1" deadline=$((SECONDS + health_timeout)) svc id status
  shift
  for svc in "$@"; do
    while :; do
      id="$("$fn" ps -q "$svc" || true)"
      status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
      [ "$status" = healthy ] && break
      if [ "$SECONDS" -ge "$deadline" ]; then
        echo "$svc is ${status:-not running} after ${health_timeout}s" >&2
        "$fn" logs --no-color --tail 40 "$svc" >&2 || true
        return 1
      fi
      sleep 5
    done
    echo "$svc is healthy"
  done
}

# Containers of a service that belong to another version: "<id> <project> <state>" per line.
others() { # <service>
  docker ps -a --filter "label=com.docker.compose.service=$1" \
    --format '{{.ID}} {{.Label "com.docker.compose.project"}} {{.State}}' |
    awk -v p="$project" '$2 != p'
}

write_env
db up -d
wait_healthy db postgres

echo "starting $project ($image) next to the running version"
if ! { app up -d && wait_healthy app gateway worker; }; then
  echo "result: $version did not become healthy; removed it, the running version keeps serving" >&2
  app down || true
  exit 1
fi

others gateway | while read -r id proj _; do
  echo "removing the gateway of $proj"
  docker rm -f "$id" > /dev/null
done

others worker | while read -r id proj state; do
  if [ "$state" = running ]; then
    docker update --restart=no "$id" > /dev/null
    docker kill --signal=SIGTERM "$id" > /dev/null
    echo "the worker of $proj is draining: it finishes its jobs and exits"
  else
    docker rm "$id" > /dev/null
    echo "removed the stopped worker of $proj"
  fi
done

printf '%s\n' "$image" > "$dir/current-image"
docker image prune -af --filter until=168h > /dev/null || echo "image prune failed" >&2
echo "result: deployed $version"
