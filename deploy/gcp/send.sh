#!/usr/bin/env bash
# CI only: AWS credentials already belong to the pull-only OIDC session.
set +x
set -euo pipefail
umask 077
: "${IMAGE:?}" "${RIN_GCP_PROJECT_ID:?}" "${RIN_GCP_ZONE:?}" "${RIN_GCP_INSTANCE:?}"
dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
stage="$(mktemp -d "${RUNNER_TEMP:-/tmp}/rin-deploy.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
aws ssm get-parameters-by-path --region ap-northeast-2 --path /rin --with-decryption \
  --query 'Parameters[].{Name:Name,Value:Value}' --output json > "$stage/parameters.json"
# Refuse multiline values rather than allowing a value to inject another env key.
jq -er '.[] | if (.Name | test("^/rin/[A-Z][A-Z0-9_]*$")) and
  (.Value | test("[\r\n\u0000]") | not)
  then "\(.Name | ltrimstr("/rin/"))=\(.Value)"
  else error("invalid SSM environment entry") end' "$stage/parameters.json" > "$stage/rin.env"
rm -f "$stage/parameters.json"
aws ecr get-login-password --region ap-northeast-2 > "$stage/ecr-password"
printf '%s\n' "$IMAGE" > "$stage/image"
cp -- "$dir/disk-preflight.sh" "$stage/disk-preflight.sh"
chmod 600 "$stage/"*
# Only public receiver source is in --command. Secrets travel solely in encrypted
# stdin. -T avoids a pty and ensures SSH returns the actual remote command status.
receiver="$(base64 < "$dir/receive.sh" | tr -d '\n')"
tar -cf - -C "$stage" rin.env ecr-password image disk-preflight.sh |
  gcloud compute ssh "$RIN_GCP_INSTANCE" --project "$RIN_GCP_PROJECT_ID" \
    --zone "$RIN_GCP_ZONE" --tunnel-through-iap --quiet --ssh-flag=-T \
    --command "sudo bash -c 'eval \"\$(printf %s $receiver | base64 -d)\"'"
