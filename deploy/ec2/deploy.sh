#!/usr/bin/env bash
# Deploys one Rin image on the EC2 host and rolls back to the previous image
# when the new one does not become healthy.
#   bash /srv/rin/deploy.sh <image> [meta]
# meta is base64 JSON from the workflow (commit title, author, url, start time),
# used for the line this script adds to the "Rin 배포" canvas.
# Runs as root through SSM Run Command (.github/workflows/deploy.yml), after
# the workflow has pulled <image> and copied this file and deploy/compose.yaml
# out of it into /srv/rin.
set -euo pipefail

image="${1:?usage: deploy.sh <image> [meta]}"
meta="${2:-}"
region=ap-northeast-2
dir=/srv/rin
env_file=/run/rin.env
canvas=F0CE56L6V29 # canvas "Rin 배포"; deploy results go here, not to the team channel
health_timeout=180

link() { # <image>: its short tag, linked to the commit
  local tag="${1##*:}"
  printf '[%s](https://github.com/2026-Softbank-Hackathon-Charlie/rin/commit/%s)' "${tag:0:7}" "$tag"
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

notify() { # <status>: one canvas line right under the heading, so the newest deploy is on top
  # The token is read inside python from the env file, never put on a command line.
  ENV_FILE="$env_file" CANVAS="$canvas" META="$meta" IMAGE="$image" STATUS="$1" python3 - <<'PY' || echo "canvas update failed: $1" >&2
import base64, json, os, sys, time, urllib.request

token = next((l.split("=", 1)[1].strip() for l in open(os.environ["ENV_FILE"]) if l.startswith("SLACK_BOT_TOKEN=")), "")
if not token:
    sys.exit("SLACK_BOT_TOKEN is not set")

# META from the workflow is base64 JSON: title, author, url, started (epoch seconds).
meta = json.loads(base64.b64decode(os.environ["META"])) if os.environ.get("META") else {}
sha = os.environ["IMAGE"].rsplit(":", 1)[-1]
title = meta.get("title", sha[:7]).replace("[", "(").replace("]", ")")
url = meta.get("url", f"https://github.com/2026-Softbank-Hackathon-Charlie/rin/commit/{sha}")
line = f"- [{title}]({url}) {os.environ['STATUS']}"
if meta:
    took = max(0, int(time.time()) - int(meta["started"]))
    line += f" - 작성자: {meta['author']}, 소요: {took // 60}분 {took % 60}초"

def call(method, body):
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
    )
    res = json.load(urllib.request.urlopen(req, timeout=10))
    if not res.get("ok"):
        sys.exit(f"{method}: {res.get('error')}")
    return res

canvas = os.environ["CANVAS"]
heads = call("canvases.sections.lookup", {"canvas_id": canvas, "criteria": {"section_types": ["h1"], "contains_text": "Rin 배포"}})["sections"]
change = {"operation": "insert_after", "section_id": heads[0]["id"]} if heads else {"operation": "insert_at_start"}
change["document_content"] = {"type": "markdown", "markdown": line + "\n"}
call("canvases.edit", {"canvas_id": canvas, "changes": [change]})
print("canvas:", line)
PY
}

prev="$(cat "$dir/current-image" 2>/dev/null || true)"
write_env
echo "deploying $image (previous: ${prev:-none})"

# compose up -d returns only after the old worker has stopped (stop_grace_period
# 5m), so the health clock starts after it.
if deploy "$image"; then
  printf '%s\n' "$image" > "$dir/current-image"
  notify "배포 완료"
  docker image prune -af --filter until=168h || echo "image prune failed" >&2
  echo "deployed $image"
  exit 0
fi

echo "deploy of $image failed" >&2
if [ -n "$prev" ] && [ "$prev" != "$image" ]; then
  if deploy "$prev"; then
    notify "배포 실패, 이전 버전 $(link "$prev")로 되돌림"
  else
    notify "배포 실패, 이전 버전 $(link "$prev")로 되돌렸지만 정상 상태가 되지 않음"
  fi
else
  notify "배포 실패, 되돌릴 이전 버전 없음"
fi
exit 1
