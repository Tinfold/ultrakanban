#!/usr/bin/env bash
# Checks that backlog_on counts only the agent's own tickets in progress against CLAIM_LIMIT, not those other agents
# or people hold: bash scripts/agent-loop/backlog-test.sh
set -u
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=tickets.sh
source "$here/tickets.sh"
BACKLOG_COLUMN=Backlog IN_PROGRESS_COLUMN='In progress' AGENT=claude LOOP_ACTOR=claude-loop CLAIM_LIMIT=2

fail=0
assignees=
# A board with the backlog setting on, tickets in progress assigned to the names in $assignees (a JSON array), and two
# of the agent's tickets elsewhere, which never count.
board() {
  jq -nc --argjson names "$assignees" '{board: {agentBacklog: true},
    columns: [{id: "b", name: "Backlog"}, {id: "p", name: "In progress"}, {id: "r", name: "Review"}],
    tickets: ([$names[] | {columnId: "p", assignee: .}]
      + [{columnId: "b", assignee: "claude/opus/high"}, {columnId: "r", assignee: "claude/opus/high"}])}'
}
# run <name> <on|off> <assignees in progress>
run() {
  local got
  assignees=$3
  if backlog_on; then got=on; else got=off; fi
  if [[ $got == "$2" ]]; then echo "ok   $1"; else echo "FAIL $1: want $2, got $got"; fail=1; fi
}

run "nothing in progress" on '[]'
run "one of the agent's tickets, below the limit" on '["claude/opus/high"]'
run "the agent's tickets fill the slots" off '["claude/opus/high", "claude/sonnet/low"]'
run "the loop's own name counts too" off '["claude", "claude-loop"]'
run "other agents' and people's tickets don't count" on '["codex/gpt/high", "someone", "claudette/x/y", "mia"]'
run "nor do unassigned ones" on '["claude/opus/high", null, null]'
exit $fail
