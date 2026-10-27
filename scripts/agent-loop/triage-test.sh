#!/usr/bin/env bash
# Tests the TRIAGE jq program with sample input: bash scripts/agent-loop/triage-test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=triage.sh
source "$here/triage.sh"

fail=0
# run <name> <expected item keys> <activity json> <issue json> <reviews json> <inline json> [state json] [local pull
# request comments json]
run() {
  local got
  got=$(jq -cs --arg agent me --arg loop loop --arg marker '<!-- m -->' --arg working 'In progress' \
    --argjson now 1000 --argjson retry 60 --argjson max 3 --argjson maxci 3 --argjson maxconflict 3 "$TRIAGE" \
    <<<"$3 null null $4 $5 $6 ${8:-[]} ${7:-{\}}" | jq -r '.fingerprint')
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
run "PR comment emoji with a skin tone" "" "[]" "$(i '👍🏽')" "[]" "[]"
run "PR comment emoji with a variation selector" "" "[]" "$(i '❤️')" "[]" "[]"
run "PR comment joined emoji" "" "[]" "$(i '🎉 👨‍💻!')" "[]" "[]"
run "PR comment in Chinese" "i3" "[]" "$(i '请修复这个错误')" "[]" "[]"
run "PR comment real" "i3" "[]" "$(i 'Please also handle the empty case')" "[]" "[]"
run "ticket comment thank you" "" "$(c 'Thank you!')" "[]" "[]" "[]"
run "ticket comment real" "t1" "$(c 'Use the other endpoint instead')" "[]" "[]" "[]"
run "ticket comment ok" "" "$(c 'ok!')" "[]" "[]" "[]"
run "ticket comment in Russian" "t1" "$(c 'Исправь опечатку')" "[]" "[]" "[]"
run "ticket comment starting with ok but real" "t1" "$(c 'ok, but also rename it')" "[]" "[]" "[]"
l() { echo "[{\"id\":\"a\",\"author\":\"$1\",\"body\":\"$2\"}]"; }
run "local PR comment real" "l1" "[]" "[]" "[]" "[]" "{}" "$(l bob 'Please rename it')"
run "local PR comment thanks" "" "[]" "[]" "[]" "[]" "{}" "$(l bob 'Thanks!')"
run "local PR comment by the agent" "" "[]" "[]" "[]" "[]" "{}" "$(l me/opus/high 'Renamed it as asked')"

# The agent's runs: one from 2026-01-01T10:00:00Z to 10:10:00Z.
runs='{"runs":[[1767261600,1767262200]]}'
at() { echo "[{\"id\":$1,\"body\":\"Please also handle the empty case\",\"$2\":\"$3\",$user}]"; }
run "PR comment during a run" "" "[]" "$(at 3 created_at 2026-01-01T10:05:00Z)" "[]" "[]" "$runs"
run "PR comment after a run" "i3" "[]" "$(at 3 created_at 2026-01-01T10:15:00Z)" "[]" "[]" "$runs"
run "PR comment before a run" "i3" "[]" "$(at 3 created_at 2026-01-01T09:59:59Z)" "[]" "[]" "$runs"
run "review during a run" "" "[]" "[]" "$(at 2 submitted_at 2026-01-01T10:00:00Z | sed 's/"id"/"state":"COMMENTED","id"/')" "[]" "$runs"
run "inline comment during a run" "" "[]" "[]" "[]" "$(at 4 created_at 2026-01-01T10:10:00.123Z)" "$runs"
run "inline comment after a run" "c4" "[]" "[]" "[]" "$(at 4 created_at 2026-01-01T10:10:01Z)" "$runs"
run "ticket comment during a run" "t1" "$(c 'Use the other endpoint instead' | sed 's/"id"/"createdAt":"2026-01-01T10:05:00Z","id"/')" "[]" "[]" "[]" "$runs"
got=$(jq -cs --arg agent me --arg loop loop --arg marker '<!-- m -->' --arg working 'In progress' \
  --argjson now 1000 --argjson retry 60 --argjson max 3 --argjson maxci 3 --argjson maxconflict 3 "$TRIAGE" \
  <<<"[] null null [] [] [] [] $runs" | jq -c '.snapshot.runs')
if [ "$got" = '[[1767261600,1767262200]]' ]; then echo "ok   snapshot keeps the runs"; else
  echo "FAIL snapshot keeps the runs: got '$got'"; fail=1; fi
exit $fail
