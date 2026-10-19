#!/usr/bin/env bash
# Tests the TRIAGE jq program with sample input: bash scripts/agent-loop/triage-test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=triage.sh
source "$here/triage.sh"

fail=0
# run <name> <expected item keys> <activity json> <issue json> <reviews json> <inline json>
run() {
  local got
  got=$(jq -cs --arg agent me --arg loop loop --arg marker '<!-- m -->' --arg working 'In progress' \
    --argjson now 1000 --argjson retry 60 --argjson max 3 --argjson maxci 3 "$TRIAGE" \
    <<<"$3 null null $4 $5 $6 {}" | jq -r '.fingerprint')
  if [ "$got" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$got'"; fail=1; fi
}
user='"user":{"login":"bob","type":"User"}'
c() { echo "[{\"type\":\"comment\",\"id\":1,\"actor\":\"bob\",\"data\":{\"body\":\"$1\"}}]"; }
r() { echo "[{\"id\":2,\"state\":\"$1\",\"body\":\"$2\",$user}]"; }
i() { echo "[{\"id\":3,\"body\":\"$1\",$user}]"; }

run "empty APPROVED review" "" "[]" "[]" "$(r APPROVED '')" "[]"
run "empty DISMISSED review" "" "[]" "[]" "$(r DISMISSED '')" "[]"
run "empty COMMENTED review" "" "[]" "[]" "$(r COMMENTED '')" "[]"
run "LGTM review" "" "[]" "[]" "$(r APPROVED 'LGTM!')" "[]"
run "CHANGES_REQUESTED with body" "r2" "[]" "[]" "$(r CHANGES_REQUESTED 'Fix the typo in README')" "[]"
run "PR comment LGTM" "" "[]" "$(i 'LGTM')" "[]" "[]"
run "PR comment thanks" "" "[]" "$(i 'Thanks!')" "[]" "[]"
run "PR comment emoji" "" "[]" "$(i '👍')" "[]" "[]"
run "PR comment real" "i3" "[]" "$(i 'Please also handle the empty case')" "[]" "[]"
run "ticket comment thank you" "" "$(c 'Thank you!')" "[]" "[]" "[]"
run "ticket comment real" "t1" "$(c 'Use the other endpoint instead')" "[]" "[]" "[]"
run "ticket comment starting with ok but real" "t1" "$(c 'ok, but also rename it')" "[]" "[]" "[]"
exit $fail
