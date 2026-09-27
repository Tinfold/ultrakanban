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

get() { curl -sf "$KANBAN/api$1"; }

# The board's IDLE_COLUMNS.
idle_columns() {
  jq -ce --arg todo "$TODO_COLUMN" --arg working "$IN_PROGRESS_COLUMN" --arg cancelled "$CANCELLED_COLUMN" \
    "$IDLE_COLUMNS" <<<"${1:-$(get "/boards/$BOARD")}"
}

# Whether a name is the agent's: the loop's own or one of its workers'.
ours() { [[ $1 == "$AGENT" || $1 == "$LOOP_ACTOR" || $1 == "$AGENT/"* ]]; }

# Sends JSON (POST unless a method is given) as the worker, or as the given actor; prints the response body and then
# the HTTP status on its own line.
post() {
  curl -s -w '\n%{http_code}' -X "${4:-POST}" "$KANBAN/api$1" \
    -H 'Content-Type: application/json' -H "X-Actor: ${3:-$worker}" -d "$2"
}

# Tells the board the agent is working on a ticket right now.
heartbeat() { curl -s -o /dev/null -X POST "$KANBAN/api/tickets/$1/heartbeat" -H "X-Actor: $worker"; }

# Comments on a ticket as the loop rather than the agent.
note() {
  curl -s -o /dev/null -X POST "$KANBAN/api/tickets/$1/comments" \
    -H 'Content-Type: application/json' -H "X-Actor: $LOOP_ACTOR" -d "$(jq -nc --arg body "$2" '{body: $body}')"
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
