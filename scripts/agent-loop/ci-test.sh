#!/usr/bin/env bash
# Checks that ci_status keeps columns aligned when a check row has empty fields (null app, no output text).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/gh" <<'EOF'
#!/bin/bash
case "$*" in
*check-runs*per_page*) echo '{"check_runs":[{"id":5,"name":"lint","status":"completed","conclusion":"failure","app":null,"output":{"annotations_count":0,"title":null,"summary":null,"text":null}}]}' ;;
*status*) echo '{"statuses":[]}' ;;
esac
EOF
chmod +x "$tmp/gh"
INFRA_PATTERN="billing"
source "$here/ci.sh"
out=$(PATH=$tmp:$PATH ci_status o/r abc)
[[ $(jq -c '.code' <<<"$out") == '["lint"]' && $(jq '.infra | length' <<<"$out") == 0 ]] || { echo "FAIL: $out"; exit 1; }
echo "ci-test: ok"
