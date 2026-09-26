#!/usr/bin/env bash
# Works an ultrakanban board with Claude Code for as long as you leave it running, one ticket at a time.
#
# Each ticket gets its own short-lived `claude -p` process that exits when the ticket is submitted for review.
# A single Claude Code session left looping for days keeps growing in memory (and swap) until the process ends;
# starting a fresh process per ticket hands all of that back to the OS after every ticket.
#
# Run it from the repository the tickets are about, with the ultrakanban skill installed:
#
#   KANBAN=http://localhost:4317 BOARD=<board id> scripts/agent-loop.sh
#
# Optional settings (environment variables):
#   AGENT               name used for claims and the X-Actor header (default: claude)
#   TODO_COLUMN         column to take tickets from (default: Todo)
#   IN_PROGRESS_COLUMN  column to move claimed tickets to (default: In progress)
#   IDLE_SECONDS        wait between checks when there is nothing to do (default: 300)
#   TICKET_TIMEOUT      stop a run that takes longer than this, as accepted by timeout(1) (default: 4h)
#   CLAUDE_ARGS         extra arguments for claude, e.g. "--model opus --permission-mode acceptEdits".
#                       `claude -p` can't ask for permission, so allow the tools it needs here or in settings.
#
# Requires curl, jq, timeout (coreutils) and claude. Stop it with Ctrl-C.

set -uo pipefail

: "${KANBAN:?set KANBAN to the board server, e.g. http://localhost:4317}"
: "${BOARD:?set BOARD to the board id}"
AGENT=${AGENT:-claude}
TODO_COLUMN=${TODO_COLUMN:-Todo}
IN_PROGRESS_COLUMN=${IN_PROGRESS_COLUMN:-In progress}
IDLE_SECONDS=${IDLE_SECONDS:-300}
TICKET_TIMEOUT=${TICKET_TIMEOUT:-4h}
read -r -a claude_args <<<"${CLAUDE_ARGS:-}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

post() {
  curl -s -w '\n%{http_code}' -X POST "$KANBAN/api$1" \
    -H 'Content-Type: application/json' -H "X-Actor: $AGENT" -d "$2"
}

trap 'log "stopped"; exit 0' INT TERM

while true; do
  body=$(jq -nc --arg agent "$AGENT" --arg column "$TODO_COLUMN" --arg moveTo "$IN_PROGRESS_COLUMN" \
    '{agent: $agent, column: $column, moveTo: $moveTo}')
  response=$(post "/boards/$BOARD/tickets/claim-next" "$body")
  status=${response##*$'\n'}
  ticket=${response%$'\n'*}

  if [[ $status == 404 && $ticket == *no_ticket_available* ]]; then
    sleep "$IDLE_SECONDS"
    continue
  elif [[ $status != 200 ]]; then
    log "claim failed (HTTP ${status:-none}): $ticket"
    sleep "$IDLE_SECONDS"
    continue
  fi

  id=$(jq -r .id <<<"$ticket")
  log "ticket #$(jq -r .number <<<"$ticket") ($id): $(jq -r .title <<<"$ticket")"

  prompt="Use the ultrakanban skill. KANBAN=$KANBAN, BOARD=$BOARD, your name (agent field and X-Actor header): $AGENT.
Ticket $id is already claimed for you and in progress. Work only this ticket; do not claim another.
If it already has a pull request, it was sent back for changes: address the feedback on that pull request's branch.
Take it through to review, check the ticket activity and pull request comments once right after submitting, then exit.
This is a non-interactive run: don't wait for review, and if you need an answer from a human, ask in a ticket comment and exit."

  timeout --foreground "$TICKET_TIMEOUT" claude -p "$prompt" ${claude_args[@]+"${claude_args[@]}"} </dev/null
  code=$?
  if [[ $code != 0 ]]; then
    log "claude exited with status $code on $id; leaving the ticket claimed for a human to check"
    note="The agent run for this ticket stopped with exit status $code (124 means it hit the $TICKET_TIMEOUT timeout).
The ticket is still claimed by $AGENT; release it to Todo to retry."
    post "/tickets/$id/comments" "$(jq -nc --arg body "$note" '{body: $body}')" >/dev/null
  fi
done
