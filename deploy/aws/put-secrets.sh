#!/usr/bin/env bash
# Writes Rin's secrets from a local file to SSM Parameter Store, each as the
# SecureString /rin/<KEY>. The host reads every /rin/* parameter on each deploy.
#   ./put-secrets.sh <file>
# The file has one KEY=VALUE per line, without quotes; blank lines and lines
# starting with # are skipped. Values are never printed, only key names.
# AWS_PROFILE defaults to hopcharlie; other accounts are refused.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash would turn /rin/... into a Windows path

file="${1:?usage: put-secrets.sh <file>}"
profile="${AWS_PROFILE:-hopcharlie}"
region=ap-northeast-2
account=525091405886
expected=(ANTHROPIC_API_KEY SLACK_BOT_TOKEN SLACK_APP_TOKEN GITHUB_APP_ID GITHUB_APP_INSTALLATION_ID GITHUB_APP_PRIVATE_KEY_B64)

got="$(aws sts get-caller-identity --profile "$profile" --query Account --output text)"
if [ "$got" != "$account" ]; then
  echo "put-secrets.sh: profile '$profile' is account $got, not the hackathon account $account" >&2
  exit 1
fi

# Check the whole file before writing anything.
keys=()
values=()
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  line="${line%$'\r'}"
  case "$line" in '' | '#'*) continue ;; esac
  key="${line%%=*}"
  if [[ "$line" != *=* || ! "$key" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
    echo "put-secrets.sh: line $n is not KEY=VALUE with an upper-case key" >&2
    exit 1
  fi
  if [ -z "${line#*=}" ]; then
    echo "put-secrets.sh: line $n ($key) has an empty value" >&2
    exit 1
  fi
  keys+=("$key")
  values+=("${line#*=}")
done < "$file"
if [ "${#keys[@]}" -eq 0 ]; then
  echo "put-secrets.sh: no KEY=VALUE lines in $file" >&2
  exit 1
fi

for i in "${!keys[@]}"; do
  aws ssm put-parameter --profile "$profile" --region "$region" \
    --name "/rin/${keys[$i]}" --type SecureString --overwrite \
    --value "${values[$i]}" > /dev/null
  echo "/rin/${keys[$i]}"
done

for key in "${expected[@]}"; do
  if [[ " ${keys[*]} " != *" $key "* ]]; then
    echo "note: $key is not in $file (left as it is in SSM)"
  fi
done
