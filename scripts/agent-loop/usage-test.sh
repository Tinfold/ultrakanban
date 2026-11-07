#!/usr/bin/env bash
# Tests the USAGE_ADDED jq program with sample input: bash scripts/agent-loop/usage-test.sh
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
USAGE_ADDED=$(sed -n "/^read -r -d '' USAGE_ADDED <<'JQ'$/,/^JQ$/p" "$here/run.sh" | sed '1d;$d')
fails=0

# Prints what the run added, given its USAGE output and that of the session's last run.
added() { jq -c --argjson before "$2" "$USAGE_ADDED" <<<"$1"; }

check() {
  if [[ $2 == "$3" ]]; then echo "ok: $1"; else
    echo "FAIL: $1: got $2, wanted $3"
    fails=$((fails + 1))
  fi
}

model() { printf '{"model":"%s","inputTokens":%s,"outputTokens":%s,"cacheReadTokens":%s,"cacheWriteTokens":%s,"costUsd":%s}' "$@"; }

first=$(model opus 10 20 30 40 1.5)
first='{"agent":"a","inputTokens":10,"outputTokens":20,"cacheReadTokens":30,"cacheWriteTokens":40,"costUsd":1.5,"durationMs":5,"apiKey":false,"models":['$first']}'

check "a session's first run counts in full" "$(added "$first" null)" "$(jq -c . <<<"$first")"

opus=$(model opus 15 25 35 45 2.5)
haiku=$(model haiku 1 2 3 4 0.25)
second='{"agent":"a","inputTokens":16,"outputTokens":27,"cacheReadTokens":38,"cacheWriteTokens":49,"costUsd":2.75,"durationMs":7,"apiKey":false,"models":['$opus,$haiku']}'
out=$(added "$second" "$first")
check "a resumed run counts what it added" "$(jq -c '[.inputTokens, .outputTokens, .cacheReadTokens, .cacheWriteTokens, .costUsd]' <<<"$out")" '[6,7,8,9,1.25]'
check "its duration is its own" "$(jq -c .durationMs <<<"$out")" 7
check "each model counts what it added" "$(jq -c '[.models[] | [.model, .inputTokens, .costUsd]]' <<<"$out")" '[["opus",5,1],["haiku",1,0.25]]'

same=$(added "$first" "$first")
check "a run that added nothing counts nothing, and no model" "$(jq -c '[.inputTokens, .costUsd, (.models | length)]' <<<"$same")" '[0,0,0]'

check "totals that went down are not the same session's" "$(added "$first" "$second")" "$(jq -c . <<<"$first")"

opus=$(model opus 15 25 35 45 null)
unknown='{"agent":"a","inputTokens":15,"outputTokens":25,"cacheReadTokens":35,"cacheWriteTokens":45,"costUsd":null,"durationMs":7,"apiKey":false,"models":['$opus']}'
out=$(added "$unknown" "$first")
check "no cost stays no cost" "$(jq -c '[.inputTokens, .costUsd, .models[0].costUsd]' <<<"$out")" '[5,null,null]'

exit $((fails > 0))
