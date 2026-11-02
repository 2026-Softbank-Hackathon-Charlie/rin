#!/usr/bin/env bash
# Deploys one Rin image on the EC2 host and rolls back to the previous image
# when the new one does not become healthy.
#   bash /srv/rin/deploy.sh <image>
# Runs as root through SSM Run Command (.github/workflows/deploy.yml), after
# the workflow has pulled <image> and copied this file and deploy/compose.yaml
# out of it into /srv/rin.
set -euo pipefail

image="${1:?usage: deploy.sh <image>}"
region=ap-northeast-2
dir=/srv/rin
env_file=/run/rin.env
channel=C0CCZ9RJ52T # #final_team_charlie
health_timeout=180

short() { # <image>: the first 7 characters of its tag
  local tag="${1##*:}"
  printf '%s' "${tag:0:7}"
}

compose() { # <image> <docker compose arguments...>
  local img="$1"
  shift
  RIN_IMAGE="$img" docker compose -p rin -f "$dir/compose.yaml" --env-file "$env_file" "$@"
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

# Waits up to $health_timeout seconds for gateway and worker to be healthy.
wait_healthy() { # <image>
  local deadline=$((SECONDS + health_timeout)) svc id status
  for svc in gateway worker; do
    while :; do
      id="$(compose "$1" ps -q "$svc" || true)"
      status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
      [ "$status" = healthy ] && break
      if [ "$SECONDS" -ge "$deadline" ]; then
        echo "$svc is ${status:-not running} after ${health_timeout}s" >&2
        compose "$1" logs --no-color --tail 40 "$svc" >&2 || true
        return 1
      fi
      sleep 5
    done
    echo "$svc is healthy"
  done
}

deploy() { # <image>
  echo "starting $1"
  compose "$1" up -d && wait_healthy "$1"
}

notify() { # <text>
  local token resp
  token="$(sed -n 's/^SLACK_BOT_TOKEN=//p' "$env_file")"
  if [ -z "$token" ]; then
    echo "SLACK_BOT_TOKEN is not set, skipping the Slack message: $1" >&2
    return 0
  fi
  # The token goes to curl on stdin (-K -), not on the command line.
  resp="$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sS --max-time 10 -K - \
      -H 'Content-Type: application/json; charset=utf-8' \
      --data "{\"channel\":\"$channel\",\"text\":\"$1\"}" \
      https://slack.com/api/chat.postMessage || true)"
  case "$resp" in
    *'"ok":true'*) ;;
    *) echo "Slack message failed: $resp" >&2 ;;
  esac
}

prev="$(cat "$dir/current-image" 2>/dev/null || true)"
write_env
echo "deploying $image (previous: ${prev:-none})"

# compose up -d returns only after the old worker has stopped (stop_grace_period
# 5m), so the health clock starts after it.
if deploy "$image"; then
  printf '%s\n' "$image" > "$dir/current-image"
  notify "Rin 배포 완료: $(short "$image")"
  docker image prune -af --filter until=168h || echo "image prune failed" >&2
  echo "deployed $image"
  exit 0
fi

echo "deploy of $image failed" >&2
if [ -n "$prev" ] && [ "$prev" != "$image" ]; then
  if deploy "$prev"; then
    notify "Rin 배포 실패: $(short "$image"), $(short "$prev")로 되돌렸습니다"
  else
    notify "Rin 배포 실패: $(short "$image"), $(short "$prev")로 되돌렸지만 정상 상태가 되지 않았습니다"
  fi
else
  notify "Rin 배포 실패: $(short "$image"), 되돌릴 이전 이미지가 없습니다"
fi
exit 1
