#!/usr/bin/env bash
# Tests the TRIAGE jq program with sample input: bash scripts/agent-loop/triage-test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=triage.sh
source "$here/triage.sh"

fail=0
# run <name> <expected item keys> <activity json> <issue json> <reviews json> <inline json> [state json] [local pull
# request comments json]; the ticket is in review unless inreview=false.
run() {
  local got
  got=$(jq -cs --arg agent me --arg loop loop --arg marker '<!-- m -->' --arg working 'In progress' \
    --argjson inreview "${inreview:-true}" --arg ghlogin "${ghlogin:-}" --argjson now 1000 --argjson retry 60 \
    --argjson max 3 --argjson maxci 3 --argjson maxconflict 3 "$TRIAGE" <<<"$3 null null $4 $5 $6 ${8:-[]} ${7:-{\}}" |
    jq -r '.fingerprint')
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
inreview=false run "ticket comment done while in progress" "t1" "$(c 'done')" "[]" "[]" "[]"
# t() <agent's comment> <a person's reply>
t() { echo "[{\"type\":\"comment\",\"id\":1,\"actor\":\"me/opus/high\",\"data\":{\"body\":\"$1\"}},
  {\"type\":\"comment\",\"id\":2,\"actor\":\"bob\",\"data\":{\"body\":\"$2\"}}]"; }
run "ticket comment ok answering the agent's question" "t2" "$(t 'Should I rename it too?' 'ok')" "[]" "[]" "[]"
run "ticket comment thanks after the agent's summary" "" "$(t 'Renamed it.' 'Thanks!')" "[]" "[]" "[]"
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
ghlogin=agent-account run "PR comment from another account during a run" "i3" "[]" \
  "$(at 3 created_at 2026-01-01T10:05:00Z)" "[]" "[]" "$runs"
ghlogin=bob run "PR comment from the agent's account during a run" "" "[]" "$(at 3 created_at 2026-01-01T10:05:00Z)" \
  "[]" "[]" "$runs"
ghlogin=agent-account run "review from another account during a run" "r2" "[]" "[]" \
  "$(at 2 submitted_at 2026-01-01T10:00:00Z | sed 's/"id"/"state":"COMMENTED","id"/')" "[]" "$runs"
run "ticket comment during a run" "t1" "$(c 'Use the other endpoint instead' | sed 's/"id"/"createdAt":"2026-01-01T10:05:00Z","id"/')" "[]" "[]" "[]" "$runs"
# triage <pull request json> <local pull request comments json> <state json> <jq filter for the result>
triage() {
  jq -cs --arg agent me --arg loop loop --arg marker '<!-- m -->' --arg working 'In progress' --argjson inreview true \
    --arg ghlogin "" \
    --argjson now 1000 --argjson retry 60 --argjson max 3 --argjson maxci 3 --argjson maxconflict 3 "$TRIAGE" \
    <<<"[] $1 null [] [] [] $2 $3" | jq -c "$4"
}
got=$(triage null '[]' "$runs" .snapshot.runs)
if [ "$got" = '[[1767261600,1767262200]]' ]; then echo "ok   snapshot keeps the runs"; else
  echo "FAIL snapshot keeps the runs: got '$got'"; fail=1; fi

# A person stopped a run that was handed the second comment on a local pull request (`stopped`, its snapshot): no new
# run until there is a third.
pr='{"state":"OPEN","url":"/b/x/pr/1"}'
two='[{"id":"a","author":"bob","body":"Please rename it"},{"id":"b","author":"bob","body":"And the test"}]'
stopped='{"local":{"pr":"/b/x/pr/1","seen":1},"stopped":{"activity":0,"local":{"pr":"/b/x/pr/1","seen":2}}}'
got=$(triage "$pr" "$two" "$stopped" .run)
if [ "$got" = false ]; then echo "ok   stopped run on a local pull request waits"; else
  echo "FAIL stopped run on a local pull request waits: got '$got'"; fail=1; fi
three=$(jq -c '. + [{"id":"c","author":"bob","body":"Go on, but keep the old name"}]' <<<"$two")
got=$(triage "$pr" "$three" "$stopped" '[.run, .fingerprint]')
if [ "$got" = '[true,"l2 l3"]' ]; then echo "ok   stopped run on a local pull request resumes on a new comment"; else
  echo "FAIL stopped run on a local pull request resumes on a new comment: got '$got'"; fail=1; fi
# A local pull request with merge conflicts (tickets.sh gives it mergeable and its head and base commits from the
# board's mergeability) starts a run only to fix them, as a GitHub one does.
local_pr='{"state":"OPEN","url":"/b/x/pr/1","baseRefName":"main","headRefOid":"h1","baseRefOid":"b1","mergeable":"CONFLICTING"}'
got=$(triage "$local_pr" '[]' '{}' '[.run, .trigger, .conflicted]')
if [ "$got" = '[true,"conflict",true]' ]; then echo "ok   local pull request with conflicts"; else
  echo "FAIL local pull request with conflicts: got '$got'"; fail=1; fi
got=$(triage "$local_pr" '[]' '{"conflict":"h1:b1"}' .run)
if [ "$got" = false ]; then echo "ok   local pull request with the same conflicts again"; else
  echo "FAIL local pull request with the same conflicts again: got '$got'"; fail=1; fi
exit $fail
