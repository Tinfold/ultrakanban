#!/usr/bin/env bash
# Works an ultrakanban board with Claude Code for as long as you leave it running, one `claude -p` at a time.
#
# A single Claude Code session left looping for days keeps growing in memory (and swap) until the process ends.
# This loop runs outside Claude Code and starts a fresh, short-lived `claude -p` for every piece of work, so all
# of that memory goes back to the OS after each run. The loop itself keeps no history, so it doesn't grow.
#
# Each round it first checks the tickets the agent holds, and starts a run for the first one with new feedback:
#   - a ticket comment from someone else
#   - a pull request comment, review or inline review comment (not from bots, and not the agent's own replies,
#     which end with the marker line <!-- ultrakanban:AGENT -->)
#   - failing checks on the pull request's latest commit
#   - merge conflicts with the base branch
# A pull request closed without merging moves its ticket to the cancelled column. Only when none of its tickets
# needs work does it claim the next ticket from the todo column.
#
# Before each run the loop takes a snapshot of what it hands over: the newest ticket activity id, the newest pull
# request comment, review and inline comment ids, and the failing checks and conflict state of the pull request's
# head commit. Only when the run exits successfully does it save that snapshot as the ticket's watermark, in a
# small file per ticket under STATE_DIR. Feedback above the watermark, including anything that arrived during the
# run, starts the next run. A failed run saves nothing and is retried after RETRY_SECONDS, doubling each time, up
# to MAX_ATTEMPTS; new feedback resets the count. A missing or unreadable state file means handling everything
# again, never skipping it.
#
# Run it from the repository the tickets are about, with the ultrakanban skill installed and gh authenticated:
#
#   KANBAN=http://localhost:4317 BOARD=<board id> scripts/agent-loop.sh
#
# Optional settings (environment variables):
#   AGENT               name used for claims and the X-Actor header (default: claude)
#   TODO_COLUMN         column to take new tickets from (default: Todo)
#   IN_PROGRESS_COLUMN  column to move claimed tickets to (default: In progress)
#   CANCELLED_COLUMN    column for tickets whose pull request was closed without merging (default: Cancelled)
#   IDLE_SECONDS        wait between rounds when there is nothing to do (default: 300)
#   TICKET_TIMEOUT      stop a run that takes longer than this, as accepted by timeout(1) (default: 4h)
#   RETRY_SECONDS       wait before retrying a failed run, doubled after each failure (default: 600)
#   MAX_ATTEMPTS        failed runs in a row before waiting for new feedback (default: 3)
#   SKIP_PERMISSIONS    1 passes --dangerously-skip-permissions to claude, 0 doesn't (default: 1)
#   CLAUDE_ARGS         extra arguments for claude, e.g. "--model opus"
#   STATE_DIR           where watermarks are kept (default: $XDG_STATE_HOME/ultrakanban-agent-loop/BOARD-AGENT)
#
# Requires curl, jq, gh, timeout (coreutils) and claude. Logs go to stdout. Stop it with Ctrl-C or SIGTERM.

set -uo pipefail

: "${KANBAN:?set KANBAN to the board server, e.g. http://localhost:4317}"
: "${BOARD:?set BOARD to the board id}"
AGENT=${AGENT:-claude}
LOOP_ACTOR="$AGENT-loop"
MARKER="<!-- ultrakanban:$AGENT -->"
TODO_COLUMN=${TODO_COLUMN:-Todo}
IN_PROGRESS_COLUMN=${IN_PROGRESS_COLUMN:-In progress}
CANCELLED_COLUMN=${CANCELLED_COLUMN:-Cancelled}
IDLE_SECONDS=${IDLE_SECONDS:-300}
TICKET_TIMEOUT=${TICKET_TIMEOUT:-4h}
RETRY_SECONDS=${RETRY_SECONDS:-600}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
STATE_DIR=${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ultrakanban-agent-loop/$BOARD-${AGENT//\//_}}
read -r -a claude_args <<<"${CLAUDE_ARGS:-}"
if [[ ${SKIP_PERMISSIONS:-1} == 1 ]]; then
  claude_args+=(--dangerously-skip-permissions)
fi
mkdir -p "$STATE_DIR" || exit 1

# Finds a ticket's new feedback. Input: its activity, open pull request (gh pr view) or null, pull request
# comments, reviews and inline comments (GitHub REST), and its saved state. Prints the snapshot to save after a
# successful run, the items to hand over, their fingerprint, and whether to run now (backoff after failures).
read -r -d '' TRIAGE <<'JQ'
def bot: (.user.type // "") == "Bot" or ((.user.login // "") | endswith("[bot]"));
def feedback: (bot | not) and ((.body // "") | contains($marker) | not);
def clip: if length > 2000 then .[:2000] + " [...]" else . end;
def failing: IN("FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE");
. as [$activity, $pr, $issue, $reviews, $inline, $s]
| ($pr // {}) as $p
| ([$p.statusCheckRollup // [] | .[] | select((.conclusion // .state // "") | failing) | .name // .context]
    | unique) as $failed
| (if $failed == [] then "" else "\($p.headRefOid):\($failed | join(","))" end) as $checks
| (if $p.mergeable == "CONFLICTING" or $p.mergeStateStatus == "DIRTY" then "\($p.headRefOid):\($p.baseRefOid)"
   else "" end) as $conflict
| {
    snapshot: {
      activity: ([$activity[].id, $s.activity // 0] | max),
      issue: ([$issue[].id, $s.issue // 0] | max),
      review: ([$reviews[].id, $s.review // 0] | max),
      inline: ([$inline[].id, $s.inline // 0] | max),
      checks: $checks,
      conflict: $conflict
    },
    items: [
      (if $s.claim then {key: "claim", text: ("The previous run on this ticket didn't finish. "
        + "Check what it got done and carry on from there.")} else empty end),
      ($activity[] | select(.type == "comment" and .id > ($s.activity // 0) and .actor != $agent and .actor != $loop)
        | {key: "t\(.id)", text: "Ticket comment from \(.actor):\n\(.data.body // "" | clip)"}),
      ($issue[] | select(.id > ($s.issue // 0) and feedback)
        | {key: "i\(.id)", text: "Pull request comment from \(.user.login) (\(.html_url)):\n\(.body // "" | clip)"}),
      ($reviews[] | select(.id > ($s.review // 0) and feedback and .state != "PENDING")
        | select(.state != "COMMENTED" or (.body // "") != "")
        | {key: "r\(.id)",
           text: "Pull request review (\(.state)) from \(.user.login) (\(.html_url)):\n\(.body // "" | clip)"}),
      ($inline[] | select(.id > ($s.inline // 0) and feedback)
        | {key: "c\(.id)", text: ("Inline review comment from \(.user.login) "
           + "on \(.path):\(.line // .original_line // "?") (\(.html_url)):\n\(.body // "" | clip)")}),
      (if $checks != "" and $checks != ($s.checks // "") then
        {key: "checks \($checks)", text: "Failing checks on \($p.headRefOid[:7]): \($failed | join(", "))"}
       else empty end),
      (if $conflict != "" and $conflict != ($s.conflict // "") then
        {key: "conflict \($conflict)", text: "The pull request has merge conflicts with \($p.baseRefName)"}
       else empty end)
    ]
  }
| .fingerprint = (.items | map(.key) | join(" "))
| .run = (.items != [] and (($s.failedFor // null) != .fingerprint or (($s.failures // 0) < $max
    and $now >= ($s.failedAt // 0) + $retry * pow(2; ($s.failures // 1) - 1))))
JQ

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

get() { curl -sf "$KANBAN/api$1"; }

# POSTs JSON as the agent; prints the response body and then the HTTP status on its own line.
post() {
  curl -s -w '\n%{http_code}' -X POST "$KANBAN/api$1" \
    -H 'Content-Type: application/json' -H "X-Actor: $AGENT" -d "$2"
}

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

run_claude() {
  timeout --foreground "$TICKET_TIMEOUT" claude -p ${claude_args[@]+"${claude_args[@]}"} <<<"$1"
}

# Runs claude on a ticket. On success saves the snapshot as the ticket's watermark; on failure keeps the old one
# and counts the failure for the backoff.
run_on_ticket() {
  local id=$1 prompt=$2 snapshot=$3 fingerprint=$4 code
  run_claude "$prompt"
  code=$?
  if [[ $code == 0 ]]; then
    write_state "$id" "$snapshot"
    return 0
  fi
  log "claude exited with status $code on $id"
  write_state "$id" "$(read_state "$id" | jq -c --arg fp "$fingerprint" --argjson now "$(date +%s)" \
    '. + {failures: (if .failedFor == $fp then (.failures // 0) + 1 else 1 end), failedAt: $now, failedFor: $fp}')"
  note "$id" "Agent run stopped with exit status $code (124 means it hit the $TICKET_TIMEOUT timeout). It is \
retried with backoff, up to $MAX_ATTEMPTS runs in a row; after that, new feedback such as a ticket comment retries it."
}

intro() {
  printf '%s' "Use the ultrakanban skill. KANBAN=$KANBAN, BOARD=$BOARD.
Your name (agent field and X-Actor header): $AGENT.
This is a non-interactive run started by scripts/agent-loop.sh: do the work, then exit. Don't wait for review; the loop
starts a new run when feedback arrives. If you need an answer from a human, ask in a ticket comment and exit.
End every pull request comment, review and inline reply you post with this exact line, so the loop doesn't mistake
your own replies for feedback:
$MARKER"
}

# Moves a ticket whose pull request was closed without merging to the cancelled column.
cancel() {
  local id=$1 number=$2 pr_url=$3 cancelled=$4 response
  if [[ -z $cancelled ]]; then
    log "error: ticket #$number ($id): $pr_url was closed without merging, but the board has no \
\"$CANCELLED_COLUMN\" column; leaving the ticket alone"
    return 1
  fi
  response=$(post "/tickets/$id/release" "$(jq -nc --arg agent "$AGENT" --arg moveTo "$cancelled" \
    '{agent: $agent, moveTo: $moveTo}')")
  if [[ ${response##*$'\n'} != 200 ]]; then
    log "error: ticket #$number ($id): can't move it to $CANCELLED_COLUMN: ${response%$'\n'*}"
    return 1
  fi
  note "$id" "Pull request $pr_url was closed without merging, so the ticket moved to $CANCELLED_COLUMN."
  rm -f "$(state_file "$id")"
  log "ticket #$number ($id): $pr_url was closed without merging; moved it to $CANCELLED_COLUMN"
}

# Checks the tickets the agent holds and handles the first one that needs work. Returns 1 if none did.
handle_feedback() {
  local board review cancelled tickets file id number column pr_url repo pr_number pr issue reviews inline activity \
    state triage items
  board=$(get "/boards/$BOARD") || { log "can't read board $BOARD"; return 1; }
  review=$(jq -r '.board.reviewColumnId // ""' <<<"$board")
  cancelled=$(jq -r --arg name "$CANCELLED_COLUMN" \
    '[.columns[] | select((.name | ascii_downcase) == ($name | ascii_downcase)) | .id][0] // ""' <<<"$board")
  tickets=$(jq -r --arg agent "$AGENT" --arg cancelled "$cancelled" '(.board.doneColumnId // "") as $done
    | .tickets[] | select(.assignee == $agent and .columnId != $done and .columnId != $cancelled)
    | [.id, .number, .columnId, .pullRequest.url // "-", .pullRequest.repo // "-", .pullRequest.number // "-"] | @tsv' \
    <<<"$board")
  board=

  # Forget tickets the agent no longer holds.
  for file in "$STATE_DIR"/*.json; do
    [[ -e $file ]] || continue
    id=${file##*/}
    id=${id%.json}
    [[ $'\n'$tickets == *$'\n'"$id"$'\t'* ]] || rm -f "$file"
  done

  while IFS=$'\t' read -r -u 3 id number column pr_url repo pr_number; do
    [[ -n $id ]] || continue
    pr=null issue='[]' reviews='[]' inline='[]'
    if [[ $pr_url != - ]]; then
      pr=$(gh pr view "$pr_url" \
        --json state,mergeable,mergeStateStatus,headRefOid,baseRefOid,baseRefName,statusCheckRollup </dev/null) ||
        { log "can't read $pr_url"; continue; }
      case $(jq -r .state <<<"$pr") in
        OPEN)
          issue=$(gh_list "repos/$repo/issues/$pr_number/comments?per_page=100") &&
            reviews=$(gh_list "repos/$repo/pulls/$pr_number/reviews?per_page=100") &&
            inline=$(gh_list "repos/$repo/pulls/$pr_number/comments?per_page=100") ||
            { log "can't read the comments on $pr_url"; continue; }
          ;;
        CLOSED)
          if [[ $column == "$review" ]]; then
            cancel "$id" "$number" "$pr_url" "$cancelled" && return 0
            continue
          fi
          pr=null
          ;;
        *) pr=null ;;
      esac
    fi

    activity=$(get "/tickets/$id/activity") || { log "can't read the activity of $id"; continue; }
    state=$(read_state "$id")
    triage=$(printf '%s\n' "$activity" "$pr" "$issue" "$reviews" "$inline" "$state" |
      jq -cs --arg agent "$AGENT" --arg loop "$LOOP_ACTOR" --arg marker "$MARKER" --argjson now "$(date +%s)" \
        --argjson retry "$RETRY_SECONDS" --argjson max "$MAX_ATTEMPTS" "$TRIAGE") ||
      { log "can't triage $id"; continue; }
    activity= pr= issue= reviews= inline=
    [[ $(jq -r .run <<<"$triage") == true ]] || continue

    items=$(jq -r '.items | map(.text) | join("\n\n---\n\n")' <<<"$triage")
    log "ticket #$number ($id): $(jq -r '.items | map(.text | split("\n")[0] | rtrimstr(":")) | join("; ")' \
      <<<"$triage")"
    run_on_ticket "$id" "$(intro)

Ticket $id is already yours. The loop started this run for this new feedback:

$items

Read the ticket's activity and, if it has a pull request, its comments, reviews, inline review comments and checks,
then address everything above: answer questions, make the requested changes, fix failing checks, and resolve merge
conflicts by merging the base branch into the pull request's branch. Commit and push to that branch.
Reply where each piece of feedback was given: on the pull request for pull request feedback (with the marker line).
If the ticket isn't in review yet, keep working it and submit it for review.
Finish with a ticket comment summarising what you did, then exit." \
      "$(jq -c .snapshot <<<"$triage")" "$(jq -r .fingerprint <<<"$triage")"
    return 0
  done 3<<<"$tickets"
  return 1
}

# Claims the next ticket from the todo column and works it. Returns 1 if there was nothing to claim.
claim_next() {
  local response status ticket id snapshot
  response=$(post "/boards/$BOARD/tickets/claim-next" "$(jq -nc --arg agent "$AGENT" --arg column "$TODO_COLUMN" \
    --arg moveTo "$IN_PROGRESS_COLUMN" '{agent: $agent, column: $column, moveTo: $moveTo}')")
  status=${response##*$'\n'}
  ticket=${response%$'\n'*}
  if [[ $status != 200 ]]; then
    [[ $status == 404 && $ticket == *no_ticket_available* ]] || log "claim failed (HTTP ${status:-none}): $ticket"
    return 1
  fi

  id=$(jq -r .id <<<"$ticket")
  log "ticket #$(jq -r .number <<<"$ticket") ($id): claimed: $(jq -r .title <<<"$ticket")"
  # Everything on the ticket so far is handed to this run. Until it succeeds, the claim itself counts as feedback,
  # so a failed or interrupted run is retried with backoff.
  snapshot=$(get "/tickets/$id/activity" | jq -c '{activity: (map(.id) | max // 0)}') || snapshot='{}'
  write_state "$id" "$(jq -c '. + {claim: true}' <<<"$snapshot")"
  run_on_ticket "$id" "$(intro)

Ticket $id is already claimed for you and in progress. Work only this ticket; do not claim another.
Take it through to review and exit after submitting it." "$snapshot" "claim"
  return 0
}

# Waits in the background so a signal ends the wait at once.
idle() {
  sleep "$IDLE_SECONDS" &
  sleeper=$!
  wait "$sleeper"
  sleeper=
}

sleeper=
trap 'log "stopped"; [[ -n $sleeper ]] && kill "$sleeper" 2>/dev/null; exit 0' INT TERM

log "working board $BOARD as $AGENT"
while true; do
  handle_feedback || claim_next || idle
done
