#!/usr/bin/env bash
# Works an ultrakanban board with Claude Code for as long as you leave it running, one `claude -p` at a time.
# Several of these loops can work one board together, each in its own checkout (see "Several loops" below).
#
# The loop is the board's agent (its controller), named AGENT. The runs it starts are its workers, and they claim
# tickets under a name made of the agent, the model and the effort level they run with: AGENT/MODEL/EFFORT, e.g.
# claude/opus/high. The loop passes that model and effort to claude, so the name always says what did the work.
# A ticket can ask for its own model and effort level (its agentModel and agentEffort); tickets that don't are worked
# with MODEL at EFFORT.
# Tickets held under another of the agent's names (another model or effort, or the bare agent name) are its own too:
# before a run on one, the loop reassigns it to the current worker.
#
# A single Claude Code session left looping for days keeps growing in memory (and swap) until the process ends.
# This loop runs outside Claude Code and starts a fresh, short-lived `claude -p` for every piece of work, so all
# of that memory goes back to the OS after each run. The loop itself keeps no history, so it doesn't grow.
#
# Each round it first checks the tickets the agent holds, and starts a run for the first one with new feedback:
#   - a ticket comment from someone else
#   - a pull request comment, review or inline review comment (not from bots, and not the agent's own replies,
#     which end with the marker line <!-- ultrakanban:AGENT -->)
#   - checks on the pull request's latest commit that ran and failed (see ci_status for what counts)
#   - merge conflicts with the base branch
#   - someone else moving the ticket into the in-progress column, e.g. back from review: they want more work on it
# A pull request closed without merging moves its ticket to the cancelled column. Only when none of its tickets
# needs work does it claim the next ticket from the todo column, or, when the board's agentBacklog setting is on and
# the todo column has none left and fewer than CLAIM_LIMIT tickets are in progress, from the backlog column.
#
# People can drag the agent's tickets around the board too. A ticket someone moves back to the todo column, or to a
# column before it such as a backlog, goes back to the queue: the loop releases it (unassigns it) and forgets its
# state, and it is claimed again from the todo column like any other ticket. While a run is going, the loop checks its
# ticket every TICKET_CHECK_SECONDS, and stops the run when someone else takes the ticket away from the agent: moves it
# back to the queue like that, or to the done or cancelled column, unassigns or reassigns it, or deletes it. Moving a
# ticket into the review column, or tickets the agent doesn't hold, changes nothing for the loop. Each of those checks
# also sends the board a heartbeat for the ticket (POST /tickets/:id/heartbeat): the board counts tickets without one
# (and without other activity) for 10 minutes as idle, and offers to move them back to the todo column. The heartbeats
# say what the run is doing (working the ticket, or the feedback it answers), and the loop tells the board when the run
# ends, so the ticket's card shows the run while it goes on.
#
# Before each run the loop takes a snapshot of what it hands over: the newest ticket activity id, the newest pull
# request comment, review and inline comment ids, and the failing checks and conflict state of the pull request's
# head commit. Only when the run exits successfully does it save that snapshot as the ticket's watermark, in a
# small file per ticket under STATE_DIR. Feedback above the watermark, including anything that arrived during the
# run, starts the next run. A failed run saves nothing and is retried after RETRY_SECONDS, doubling each time, up
# to MAX_ATTEMPTS; new feedback resets the count. A missing or unreadable state file means handling everything
# again, never skipping it.
#
# Runs get only the ultrakanban skill, in their system prompt, unless the board's agentAllSkills setting is on or the
# repository has skills or commands of its own (under .claude/): the account's and plugins' skills are listed in every
# request a run makes, and it has no use for them.
#
# Each run's token usage (from claude's JSON output) is reported to the board with POST /tickets/:id/usage, so the
# overview can show how many tokens each agent uses. A run stopped by the timeout reports nothing.
#
# CI can fail for reasons that aren't the code, and a fix can fail again. So a failing check counts once per commit
# and check name (re-running CI on the same commit doesn't start a run), checks that never ran or failed for billing,
# runner or approval reasons never start a run (the loop notes them on the ticket once per commit), and after
# MAX_CI_RUNS runs in a row started only by CI, it stops starting CI runs for the ticket until a human comments.
#
# A run that fails because the account is out of Claude usage doesn't count as a failure. The loop says so on the
# ticket, quoting claude's message, and starts no runs at all until the time the message says the limit resets
# (RETRY_SECONDS later if it doesn't say), then resumes the run.
#
# Runs that don't finish are resumed, not started over. Each run is a claude session, and a run cut short by the
# usage limit or by the loop stopping (a restart of the service or the machine, a crash) is continued in that same
# session (claude --resume), so it keeps everything it already knew and did. With AGENT_LOOP_CLEAN=1, the work such a
# run (or a failed one) left in the checkout isn't discarded either: the loop keeps its commits and uncommitted
# changes under refs/ultrakanban/work/<ticket> and puts them back before the ticket's next run, in whichever checkout.
#
# Several loops: to work several tickets at once, run one loop per checkout of the repository, e.g. the clone and git
# worktrees of it (agent-board.sh does this for a board's agentConcurrency), all with the same BOARD, AGENT and
# STATE_DIR. They share the watermarks and the usage-limit pause, and locks in STATE_DIR keep them apart: a loop only
# looks at or runs a ticket while it holds that ticket's lock, so no two loops ever work the same ticket. With
# AGENT_LOOP_CLEAN=1 the default branch is checked out detached (a branch can only be checked out in one worktree),
# and fetches are serialized.
#
# Run it from the repository the tickets are about, with the ultrakanban skill installed and gh authenticated:
#
#   KANBAN=http://localhost:4317 BOARD=<board id> scripts/agent-loop.sh
#
# Optional settings (environment variables):
#   AGENT               name of the board's agent; its workers claim tickets as AGENT/MODEL/EFFORT (default: claude)
#   MODEL               Claude model the workers run, an alias or a full name such as claude-opus-5-5 (default: opus)
#   EFFORT              effort level the workers run at unless the ticket sets its own: low, medium, high, xhigh
#                       or max (default: medium)
#   TODO_COLUMN         column to take new tickets from (default: Todo)
#   BACKLOG_COLUMN      column to take new tickets from when the todo column has none, the board's agentBacklog
#                       setting is on and the in-progress column holds fewer than CLAIM_LIMIT tickets (default: Backlog)
#   IN_PROGRESS_COLUMN  column to move claimed tickets to (default: In progress)
#   CANCELLED_COLUMN    column for tickets whose pull request was closed without merging (default: Cancelled)
#   IDLE_SECONDS        wait between rounds when there is nothing to do (default: 300); the board can cut it short
#   TICKET_TIMEOUT      stop a run that takes longer than this, as accepted by timeout(1) (default: 4h)
#   TICKET_CHECK_SECONDS  how often a run's ticket is checked for having been taken away from the agent, and a
#                       heartbeat sent for it; keep it well under 10 minutes (default: 30)
#   RETRY_SECONDS       wait before retrying a failed run, doubled after each failure (default: 600)
#   MAX_ATTEMPTS        failed runs in a row before waiting for new feedback (default: 3)
#   MAX_CI_RUNS         runs in a row started only by failing CI, with no human feedback between (default: 2)
#   CLAIM_LIMIT         most new tickets claimed whose first run hasn't finished yet (it is going, failed or stopped),
#                       across the loops sharing STATE_DIR: no loop claims another while that many are pending, so
#                       runs that fail right away don't drag the whole todo column into progress (default: 1;
#                       agent-board.sh sets it to the board's agentConcurrency)
#   SKIP_PERMISSIONS    1 passes --dangerously-skip-permissions to claude, 0 doesn't (default: 1)
#   STRICT_MCP          1 passes --strict-mcp-config to claude, so runs load no MCP servers (the account's connectors,
#                       plugins' or the repository's) except those given with --mcp-config in CLAUDE_ARGS: their tools
#                       and instructions are sent with every request of a run. 0 loads them as usual (default: 1)
#   DISALLOWED_TOOLS    Claude Code tools the runs don't get, separated by spaces: every tool's definition is sent with
#                       each request of a run, and a run started by the loop has no use for these. Empty gives the runs
#                       every tool (default: ScheduleWakeup CronCreate CronDelete CronList RemoteTrigger
#                       PushNotification ListAgents SendMessage EnterWorktree ExitWorktree DesignSync)
#   CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS, BASH_MAX_OUTPUT_LENGTH
#                       the most tokens of a file one Read returns to a run, and the most characters of a command's
#                       output it sees: whatever a run reads is sent again with each of its later requests, so a big
#                       read costs many times its size (default: 10000 and 15000; Claude Code's own are 25000 and 30000)
#   CLAUDE_ARGS         extra arguments for claude; set the model and effort with MODEL and EFFORT, not here
#   STATE_DIR           where watermarks are kept (default: $XDG_STATE_HOME/ultrakanban-agent-loop/BOARD-AGENT)
#   AGENT_LOOP_CLEAN    1 when running in a dedicated clone: before each run the loop fetches, discards local
#                       changes and checks out the default branch (or the pull request's branch for feedback runs).
#                       agent-board.sh sets it. Leave it unset in a working copy of your own.
#   MAX_BUILD_GB        with AGENT_LOOP_CLEAN=1, the most GB of ignored files (build output such as target/ or
#                       node_modules/) a checkout keeps between runs; over it, they are all removed before the next
#                       run, which then builds from scratch. 0 never removes them (default: 20)
#   LOOP_ID             label for this loop's log lines when several loops work the board (agent-board.sh numbers them)
#   WATCH_FILES         files separated by ":"; when one of them changes, the loop exits with status 75 before its next
#                       run, so it can be started again with the new version (agent-board.sh sets it to the installed
#                       scripts and skill)
#
# Requires curl, jq, gh, timeout (coreutils), flock and uuidgen (util-linux) and claude. Logs go to stdout. Stop it with
# Ctrl-C or SIGTERM.

set -uo pipefail

: "${KANBAN:?set KANBAN to the board server, e.g. http://localhost:4317}"
: "${BOARD:?set BOARD to the board id}"
AGENT=${AGENT:-claude}
MODEL=${MODEL:-opus}
EFFORT=${EFFORT:-medium}
WORKER="$AGENT/$MODEL/$EFFORT"
# The model, effort and name of the run being prepared; use_worker sets them per ticket.
model=$MODEL
effort=$EFFORT
worker=$WORKER
LOOP_ACTOR="$AGENT-loop"
MARKER="<!-- ultrakanban:$AGENT -->"
TODO_COLUMN=${TODO_COLUMN:-Todo}
BACKLOG_COLUMN=${BACKLOG_COLUMN:-Backlog}
IN_PROGRESS_COLUMN=${IN_PROGRESS_COLUMN:-In progress}
CANCELLED_COLUMN=${CANCELLED_COLUMN:-Cancelled}
IDLE_SECONDS=${IDLE_SECONDS:-300}
TICKET_TIMEOUT=${TICKET_TIMEOUT:-4h}
TICKET_CHECK_SECONDS=${TICKET_CHECK_SECONDS:-30}
RETRY_SECONDS=${RETRY_SECONDS:-600}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
MAX_CI_RUNS=${MAX_CI_RUNS:-2}
MAX_BUILD_GB=${MAX_BUILD_GB:-20}
CLAIM_LIMIT=${CLAIM_LIMIT:-1}
# Check output or annotations that mean CI itself didn't run, not that the code failed.
INFRA_PATTERN='billing|spending limit|payments have failed|account is locked|account has been locked'
INFRA_PATTERN+='|was not started|minutes quota|exceeded .*(minutes|quota)'
# What claude prints when the account is out of Claude usage, e.g. "You've hit your session limit · resets 2:50pm
# (America/New_York)".
USAGE_LIMIT_PATTERN="hit your [a-z -]*limit|usage limit|limit reached|out of (extra )?usage"
STATE_DIR=${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ultrakanban-agent-loop/$BOARD-${AGENT//\//_}}
read -r -a claude_args <<<"${CLAUDE_ARGS:-}"
if [[ ${SKIP_PERMISSIONS:-1} == 1 ]]; then
  claude_args+=(--dangerously-skip-permissions)
fi
if [[ ${STRICT_MCP:-1} == 1 ]]; then
  claude_args+=(--strict-mcp-config)
fi
DISALLOWED_TOOLS=${DISALLOWED_TOOLS-ScheduleWakeup CronCreate CronDelete CronList RemoteTrigger PushNotification \
ListAgents SendMessage EnterWorktree ExitWorktree DesignSync}
read -r -a disallowed <<<"$DISALLOWED_TOOLS"
if ((${#disallowed[@]})); then
  claude_args+=(--disallowedTools "$(IFS=,; echo "${disallowed[*]}")")
fi
export CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS=${CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS:-10000}
export BASH_MAX_OUTPUT_LENGTH=${BASH_MAX_OUTPUT_LENGTH:-15000}
mkdir -p "$STATE_DIR" || exit 1

# The rest of the loop is split into parts by what they do, so that changing one means reading only that part.
parts=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/agent-loop
for part in triage board ci checkout run tickets; do
  [[ -r $parts/$part.sh ]] || { echo "agent-loop: $parts/$part.sh is missing" >&2; exit 1; }
  # shellcheck source=/dev/null
  . "$parts/$part.sh"
done

# Waits the given number of seconds in the background, so a signal ends the wait at once.
pause() {
  sleep "$1" &
  sleeper=$!
  wait "$sleeper"
  sleeper=
}

# Waits the given number of seconds, or less when someone wakes the board's agent up (a `wake` event on the board's
# event stream, sent by the review column's "fix conflicts" button). Waits them out anyway if the stream can't be read.
idle() {
  local line end=$((SECONDS + $1)) events
  exec {events}< <(exec curl -sfN --max-time "$1" "$KANBAN/api/events?board=$BOARD" 2>/dev/null)
  listener=$!
  while IFS= read -r line <&"$events"; do
    [[ $line == 'event: wake' ]] && break
  done
  exec {events}<&-
  kill "$listener" 2>/dev/null
  listener=
  if [[ $line == 'event: wake' ]]; then
    log "woken up from the board"
  elif ((end > SECONDS)); then
    pause "$((end - SECONDS))"
  fi
}

sleeper=
listener=
# Set when Claude usage runs out: no run starts before this time (seconds since the epoch). Kept in PAUSE_FILE, so
# the other loops working the board wait too.
paused_until=0
# The pending claims last reported as holding back claim_next, so the log says it once rather than every round.
claim_held=
# The run in progress and the process watching its ticket (see run_claude), if any.
running=
watcher=
trap 'log "stopped"; kill $sleeper $listener $running $watcher 2>/dev/null; exit 0' INT TERM

# `agent-loop.sh save-work` only keeps the work of an unfinished run in the current checkout (see save_work):
# agent-board.sh does this before it removes a worktree.
if [[ ${1:-} == save-work ]]; then
  save_work
  exit
fi

# The files in WATCH_FILES as they are now, to tell when one of them is replaced or changed.
watched() {
  local files file
  IFS=: read -r -a files <<<"${WATCH_FILES:-}"
  for file in ${files[@]+"${files[@]}"}; do
    stat -c '%n %i %Y %s' "$file" 2>/dev/null || printf '%s missing\n' "$file"
  done
}
watching=$(watched)

log "working board $BOARD as $AGENT, claiming tickets as $WORKER (or with the model and effort a ticket asks for)"
# A run stopped along with the loop left its work here; keep it now, so whichever loop resumes the ticket gets it back.
if [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then save_work; fi
while true; do
  paused && pause "$((paused_until - $(date +%s)))"
  if [[ $(watched) != "$watching" ]]; then
    log "the agent scripts were updated; stopping to start again with the new ones"
    exit 75
  fi
  handle_feedback || claim_next || idle "$IDLE_SECONDS"
done
