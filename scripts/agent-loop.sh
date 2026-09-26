#!/usr/bin/env bash
# Works an ultrakanban board with Claude Code for as long as you leave it running, one `claude -p` at a time.
#
# A single Claude Code session left looping for days keeps growing in memory (and swap) until the process ends.
# This loop runs outside Claude Code and starts a fresh, short-lived `claude -p` for every piece of work, so all
# of that memory goes back to the OS after each run. The loop itself keeps no history, so it doesn't grow.
#
# Each round it first checks the tickets the agent already holds, and starts a run for the first one that needs
# work:
#   - a new ticket comment from someone else
#   - a new pull request comment, review or inline review comment
#   - a failing check on the pull request
#   - merge conflicts with the base branch
# Feedback counts as handled once the agent has acted on the ticket after it (every run ends with a ticket
# comment), so no state file is needed. A pull request closed without merging releases its ticket. Only when
# nothing needs attention does it claim the next ticket from the todo column.
#
# A run that fails, or ends without the agent acting on the ticket, is retried after RETRY_SECONDS, doubling each
# time. After MAX_ATTEMPTS failed runs it waits for new feedback, such as a ticket comment.
#
# Run it from the repository the tickets are about, with the ultrakanban skill installed and gh authenticated:
#
#   KANBAN=http://localhost:4317 BOARD=<board id> scripts/agent-loop.sh
#
# Optional settings (environment variables):
#   AGENT               name used for claims and the X-Actor header (default: claude)
#   TODO_COLUMN         column to take new tickets from, and to release tickets to (default: Todo)
#   IN_PROGRESS_COLUMN  column to move claimed tickets to (default: In progress)
#   IDLE_SECONDS        wait between rounds when there is nothing to do (default: 300)
#   TICKET_TIMEOUT      stop a run that takes longer than this, as accepted by timeout(1) (default: 4h)
#   RETRY_SECONDS       wait before retrying a failed run, doubled after each failure (default: 600)
#   MAX_ATTEMPTS        failed runs in a row before waiting for new feedback (default: 3)
#   SKIP_PERMISSIONS    1 passes --dangerously-skip-permissions to claude, 0 doesn't (default: 1)
#   CLAUDE_ARGS         extra arguments for claude, e.g. "--model opus"
#
# Requires curl, jq, gh, timeout (coreutils) and claude. Logs go to stdout. Stop it with Ctrl-C or SIGTERM.

set -uo pipefail

: "${KANBAN:?set KANBAN to the board server, e.g. http://localhost:4317}"
: "${BOARD:?set BOARD to the board id}"
AGENT=${AGENT:-claude}
LOOP_ACTOR="$AGENT-loop"
TODO_COLUMN=${TODO_COLUMN:-Todo}
IN_PROGRESS_COLUMN=${IN_PROGRESS_COLUMN:-In progress}
IDLE_SECONDS=${IDLE_SECONDS:-300}
TICKET_TIMEOUT=${TICKET_TIMEOUT:-4h}
RETRY_SECONDS=${RETRY_SECONDS:-600}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
read -r -a claude_args <<<"${CLAUDE_ARGS:-}"
RETRY_NOTE="Unhandled feedback is retried with backoff, up to $MAX_ATTEMPTS runs in a row. Comment on the ticket to \
retry after that, or to retry a new ticket's run."
if [[ ${SKIP_PERMISSIONS:-1} == 1 ]]; then
  claude_args+=(--dangerously-skip-permissions)
fi

# Decides whether a ticket needs a run. Input: the ticket's activity, then its open pull request, the newest
# inline review comment on it and the base branch's head commit date if it has conflicts (each JSON or null).
# Prints the reasons for a run, or nothing.
read -r -d '' TRIAGE <<'JQ'
def ts: capture("^(?<s>[^.Z]+)(?<f>\\.[0-9]+)?Z$") | (.s + "Z" | fromdateiso8601) + ("0" + (.f // "") | tonumber);
def failed: IN("FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE");
. as [$activity, $pr, $inline, $base]
| ([$activity[] | select(.actor == $agent) | .createdAt | ts] | max // 0) as $handled
| [ ($activity[] | select(.type == "comment" and .actor != $agent and .actor != $loop)
      | {t: (.createdAt | ts), what: "a ticket comment from \(.actor)"}),
    ($pr // {} | .comments // [] | .[] | {t: (.createdAt | ts), what: "a pull request comment from \(.author.login)"}),
    ($pr // {} | .reviews // [] | .[] | select(.submittedAt)
      | {t: (.submittedAt | ts), what: "a pull request review from \(.author.login)"}),
    ($inline // empty | {t: (.created_at | ts), what: "an inline review comment from \(.user.login)"}),
    ($pr // {} | .statusCheckRollup // [] | .[] | select((.conclusion // .state // "") | failed)
      | (.completedAt // .startedAt // empty) as $at
      | {t: ($at | ts), what: "failing check \(.name // .context)"}),
    ($base // empty | {t: ts, what: "merge conflicts with the base branch"})
  ]
| map(select(.t > $handled))
| select(length > 0)
| (map(.t) | max) as $latest
| [$activity[] | select(.actor == $loop and .type == "comment" and (.data.body | startswith("Agent run")))
    | .createdAt | ts | select(. > $latest)] as $failures
| select(($failures | length) < $max)
| select(($failures | length) == 0 or $now >= ($failures | max) + $retry * pow(2; ($failures | length) - 1))
| unique_by(.what) | map(.what) | join("; ")
JQ

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

get() { curl -sf "$KANBAN/api$1"; }

# POSTs JSON as the agent; prints the response body and then the HTTP status on its own line.
post() {
  curl -s -w '\n%{http_code}' -X POST "$KANBAN/api$1" \
    -H 'Content-Type: application/json' -H "X-Actor: $AGENT" -d "$2"
}

# Comments on a ticket as the loop rather than the agent, so it doesn't count as handling feedback.
note() {
  curl -s -o /dev/null -X POST "$KANBAN/api/tickets/$1/comments" \
    -H 'Content-Type: application/json' -H "X-Actor: $LOOP_ACTOR" -d "$(jq -nc --arg body "$2" '{body: $body}')"
}

last_agent_action() {
  get "/tickets/$1/activity" | jq -r --arg agent "$AGENT" '[.[] | select(.actor == $agent) | .createdAt] | max // ""'
}

run_claude() {
  timeout --foreground "$TICKET_TIMEOUT" claude -p "$1" ${claude_args[@]+"${claude_args[@]}"} </dev/null
}

# Runs claude on a ticket and records a failure (which starts the backoff) unless the agent acted on the ticket.
run_on_ticket() {
  local id=$1 prompt=$2 before code
  before=$(last_agent_action "$id")
  run_claude "$prompt"
  code=$?
  if [[ $code != 0 ]]; then
    log "claude exited with status $code on $id"
    note "$id" "Agent run stopped with exit status $code (124 means it hit the $TICKET_TIMEOUT timeout). $RETRY_NOTE"
  elif [[ $(last_agent_action "$id") == "$before" ]]; then
    log "claude finished without acting on $id"
    note "$id" "Agent run finished without commenting on the ticket. $RETRY_NOTE"
  fi
}

intro() {
  printf '%s' "Use the ultrakanban skill. KANBAN=$KANBAN, BOARD=$BOARD.
Your name (agent field and X-Actor header): $AGENT.
This is a non-interactive run started by scripts/agent-loop.sh: do the work, then exit. Don't wait for review; the loop
starts a new run when feedback arrives. If you need an answer from a human, ask in a ticket comment and exit."
}

# Checks the tickets the agent holds and handles the first one that needs work. Returns 1 if none did.
handle_feedback() {
  local board review done_column tickets id number column pr_url repo pr_number pr state release inline base activity \
    reasons
  board=$(get "/boards/$BOARD") || { log "can't read board $BOARD"; return 1; }
  review=$(jq -r '.board.reviewColumnId // ""' <<<"$board")
  done_column=$(jq -r '.board.doneColumnId // ""' <<<"$board")
  tickets=$(jq -r --arg agent "$AGENT" --arg done "$done_column" '.tickets[]
    | select(.assignee == $agent and .columnId != $done)
    | [.id, .number, .columnId, .pullRequest.url // "-", .pullRequest.repo // "-", .pullRequest.number // "-"] | @tsv' \
    <<<"$board")
  board=

  while IFS=$'\t' read -r -u 3 id number column pr_url repo pr_number; do
    pr=null inline=null base=null
    if [[ $pr_url != - ]]; then
      pr=$(gh pr view "$pr_url" --json state,mergeable,mergeStateStatus,baseRefName,comments,reviews,statusCheckRollup \
        </dev/null) || { log "can't read $pr_url"; continue; }
      state=$(jq -r .state <<<"$pr")
      if [[ $state == CLOSED && $column == "$review" ]]; then
        release=$(post "/tickets/$id/release" "$(jq -nc --arg agent "$AGENT" --arg moveTo "$TODO_COLUMN" \
          '{agent: $agent, moveTo: $moveTo}')")
        if [[ ${release##*$'\n'} != 200 ]]; then
          log "ticket #$number ($id): can't release it after $pr_url was closed: ${release%$'\n'*}"
          continue
        fi
        log "ticket #$number ($id): $pr_url was closed without merging; released it to $TODO_COLUMN"
        note "$id" "Pull request $pr_url was closed without merging, so the ticket went back to $TODO_COLUMN. \
See the pull request for why."
        return 0
      elif [[ $state != OPEN ]]; then
        pr=null
      else
        inline=$(gh api "repos/$repo/pulls/$pr_number/comments?sort=created&direction=desc&per_page=1" </dev/null |
          jq '.[0]') || { log "can't read review comments on $pr_url"; continue; }
        # A conflict has no timestamp of its own; it appeared no earlier than the base branch's newest commit.
        if jq -e '.mergeable == "CONFLICTING" or .mergeStateStatus == "DIRTY"' >/dev/null <<<"$pr"; then
          base=$(gh api "repos/$repo/commits/$(jq -r .baseRefName <<<"$pr")" </dev/null |
            jq '.commit.committer.date') || base=null
        fi
      fi
    fi

    activity=$(get "/tickets/$id/activity") || { log "can't read the activity of $id"; continue; }
    reasons=$(printf '%s\n' "$activity" "$pr" "$inline" "$base" |
      jq -rs --arg agent "$AGENT" --arg loop "$LOOP_ACTOR" --argjson now "$(date +%s)" \
        --argjson retry "$RETRY_SECONDS" --argjson max "$MAX_ATTEMPTS" "$TRIAGE")
    activity= pr= inline=
    [[ -n $reasons ]] || continue

    log "ticket #$number ($id): $reasons"
    run_on_ticket "$id" "$(intro)
Ticket $id is already yours. This run was started because of: $reasons.
Read the ticket's activity and, if it has a pull request, the pull request's comments, reviews, inline review comments
and checks. Act on everything new: answer questions, make the requested changes, fix failing checks, and resolve merge
conflicts by merging the base branch into the pull request's branch. Push to that branch and reply on the pull request.
If the ticket isn't in review yet, keep working it and submit it for review.
Before finishing, re-read the ticket activity and pull request comments for anything that arrived meanwhile.
Your last action must be a comment on the ticket summarising what you did, even if nothing needed changing: that is how
the loop knows this feedback is handled."
    return 0
  done 3<<<"$tickets"
  return 1
}

# Claims the next ticket from the todo column and works it. Returns 1 if there was nothing to claim.
claim_next() {
  local response status ticket id
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
  run_on_ticket "$id" "$(intro)
Ticket $id is already claimed for you and in progress. Work only this ticket; do not claim another.
If it links a pull request that was closed without merging, find out why from the ticket and pull request comments
before starting again.
Take it through to review and exit after submitting it."
  return 0
}

trap 'log "stopped"; exit 0' INT TERM

log "working board $BOARD as $AGENT"
while true; do
  handle_feedback || claim_next || sleep "$IDLE_SECONDS"
done
