# Helpers: logging, ticket locks, the usage-limit pause, board API calls and saved ticket state.
# Part of agent-loop.sh, which sources it; the settings it uses are described there.

# Works the next ticket with the given model and at the given effort level (the ticket's own), or with MODEL and at
# EFFORT for those that are empty.
use_worker() {
  model=${1:-$MODEL}
  effort=${2:-$EFFORT}
  worker="$AGENT/$model/$effort"
}

log() { printf '%s %s%s\n' "$(date '+%F %T')" "${LOOP_ID:+[$LOOP_ID] }" "$*"; }

# The ticket lock this loop holds (a file descriptor), if any. Loops sharing STATE_DIR only triage, note on or run a
# ticket while they hold its lock, so they never work the same ticket at once.
lock_fd=
lock_ticket() {
  exec {lock_fd}>"$STATE_DIR/$1.lock" && flock -n "$lock_fd" && return 0
  unlock_ticket
  return 1
}
unlock_ticket() {
  if [[ -n $lock_fd ]]; then exec {lock_fd}>&-; fi
  lock_fd=
}

# Claiming a ticket (exclusive) can't overlap with reading the tickets the agent holds (shared), so no loop sees a
# newly claimed ticket before its claim is saved and locked, and none forgets its state as not the agent's.
claim_fd=
claim_lock() { exec {claim_fd}>"$STATE_DIR/claim.lock" && flock "$1" "$claim_fd"; }
claim_unlock() {
  if [[ -n $claim_fd ]]; then exec {claim_fd}>&-; fi
  claim_fd=
}

# Where loops sharing STATE_DIR keep the time no run may start before, when Claude usage ran out.
PAUSE_FILE=$STATE_DIR/paused-until

# Whether Claude usage ran out (in this loop or another one) and hasn't reset yet. Sets paused_until.
paused() {
  paused_until=$(cat "$PAUSE_FILE" 2>/dev/null)
  [[ $paused_until =~ ^[0-9]+$ ]] || paused_until=0
  ((paused_until > $(date +%s)))
}

# Where loops sharing STATE_DIR keep the time until which runs go on the agents' API key (AGENT_API_KEY), when Claude
# usage ran out and the board allows that (see AgentApiKey in shared/domain.ts): the time the limit resets.
API_KEY_FILE=$STATE_DIR/api-key-until

# Where loops sharing STATE_DIR note when they last lifted the pause early (see usage_back).
USAGE_BACK_FILE=$STATE_DIR/usage-back

# Whether Claude usage is back before the time its limit message gave, as when it is reset on claude.ai or more is
# bought: the supervisor's report on the board (GET /system/claude-usage), read after the pause began, has limits and
# none of them used up. If so, lifts the pause for every loop sharing STATE_DIR. Not when the limit was reached again
# within an hour of lifting it early, which means the report was wrong: then the pause lasts as long as the message says.
# Given API_KEY_FILE, it is about runs going on the API key instead of the pause: they go back to the plan.
usage_back() {
  local file=${1:-$PAUSE_FILE} since lifted usage
  since=$(stat -c %Y "$file" 2>/dev/null) || return 1
  lifted=$(stat -c %Y "$USAGE_BACK_FILE" 2>/dev/null) || lifted=0
  ((since - lifted > 3600)) || return 1
  usage=$(get /system/claude-usage) || return 1
  jq -e --argjson since "$since" '(.reportedAt // "" | sub("\\.[0-9]+"; "") | try fromdateiso8601 catch 0) > $since
    and .error == null and (.limits | length > 0 and all(.percent < 100))' <<<"$usage" >/dev/null || return 1
  touch "$USAGE_BACK_FILE"
  rm -f "$file"
  if [[ $file == "$PAUSE_FILE" ]]; then
    paused_until=0
    log "Claude usage is back before the time its limit message gave; resuming"
  else
    log "Claude usage is back before the time its limit message gave; runs go back from the API key to the plan"
  fi
}

# Whether the next run goes on the agents' API key: Claude usage ran out (in this loop or another one), the limit
# hasn't reset (nor is usage back early, see usage_back), and the board still allows it (GET /system/claude-usage's
# apiKey.usable: switched on, and under the monthly cap). Sets api_key_budget to what the run may spend: the run's cap,
# or what is left of the month's if that is less. When the board no longer allows it, or the loop has no key, runs wait
# for the limit like any other, so this turns into the usage-limit pause and returns 1.
use_api_key() {
  local until settings
  api_key_budget=
  until=$(cat "$API_KEY_FILE" 2>/dev/null)
  [[ $until =~ ^[0-9]+$ ]] && ((until > $(date +%s))) || return 1
  usage_back "$API_KEY_FILE" && return 1
  if [[ -n ${AGENT_API_KEY:-} ]] && settings=$(get /system/claude-usage) &&
    api_key_budget=$(jq -er '.apiKey | select(.usable) | [.runBudgetUsd, if .monthlyBudgetUsd == null then empty
      else .monthlyBudgetUsd - .spentThisMonthUsd end] | min | . * 100 | floor / 100 | select(. > 0)' <<<"$settings"); then
    return 0
  fi
  api_key_budget=
  rm -f "$API_KEY_FILE"
  printf '%s\n' "$until" >"$PAUSE_FILE"
  paused_until=$until
  log "runs may no longer go on the API key (switched off, over its monthly cap, or no AGENT_API_KEY); waiting until \
$(date -d "@$until" '+%F %T') for Claude usage"
  return 1
}

get() { curl -sf "$KANBAN/api$1"; }

# The board (compact: its tickets without descriptions and the like), fetched once per round by refresh_board and
# reused by everything that reads it during the round. Fetches it itself if the round's fetch failed.
board_json=
refresh_board() { board_json=$(get "/boards/$BOARD?compact=true") || board_json=; }
board() {
  [[ -n $board_json ]] || refresh_board
  [[ -n $board_json ]] && printf '%s\n' "$board_json"
}

# The board's IDLE_COLUMNS.
idle_columns() {
  jq -ce --arg todo "$TODO_COLUMN" --arg working "$IN_PROGRESS_COLUMN" --arg cancelled "$CANCELLED_COLUMN" \
    "$IDLE_COLUMNS" <<<"${1:-$(board)}"
}

# Whether a name is the agent's: the loop's own or one of its workers'.
ours() { [[ $1 == "$AGENT" || $1 == "$LOOP_ACTOR" || $1 == "$AGENT/"* ]]; }

# Sends JSON (POST unless a method is given) as the worker, or as the given actor; prints the response body and then
# the HTTP status on its own line.
post() {
  curl -s -w '\n%{http_code}' -X "${4:-POST}" "$KANBAN/api$1" \
    -H 'Content-Type: application/json' -H "X-Actor: ${3:-$worker}" -d "$2"
}

# Tells the board the agent is working on a ticket right now, and what the run is doing (run_step), so the ticket's
# card shows the run.
heartbeat() {
  curl -s -o /dev/null -X POST "$KANBAN/api/tickets/$1/heartbeat" -H 'Content-Type: application/json' \
    -H "X-Actor: $worker" -d "$(jq -nc --arg step "${run_step:-}" 'if $step == "" then {} else {step: $step} end')"
}

# Tells the board the run on a ticket has ended.
end_run() { curl -s -o /dev/null -X DELETE "$KANBAN/api/tickets/$1/heartbeat" -H "X-Actor: $worker"; }

# Comments on a ticket as the loop rather than the agent. With a third argument "notify", the comment needs a
# person, so the board also sends its notification (if it has a notifyUrl).
note() {
  curl -s -o /dev/null -X POST "$KANBAN/api/tickets/$1/comments" \
    -H 'Content-Type: application/json' -H "X-Actor: $LOOP_ACTOR" \
    -d "$(jq -nc --arg body "$2" --arg notify "${3:-}" '{body: $body} + if $notify == "notify" then {notify: true} else {} end')"
}

# All pages of a GitHub REST list as one array.
gh_list() { gh api --paginate "$1" </dev/null | jq -cs 'add // []'; }

state_file() { printf '%s/%s.json' "$STATE_DIR" "$1"; }

# A ticket's saved state, or {} if it is missing or unreadable (which means handling everything again).
read_state() {
  jq -cs '.[0] | if type == "object" then . else {} end' "$(state_file "$1")" 2>/dev/null || echo '{}'
}

write_state() {
  local file
  file=$(state_file "$1")
  printf '%s\n' "$2" >"$file.tmp" && mv "$file.tmp" "$file"
}

# Applies a jq filter to a ticket's saved state; $v in the filter is the third argument.
update_state() {
  write_state "$1" "$(read_state "$1" | jq -c --arg v "${3:-}" "$2")"
}
