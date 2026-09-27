#!/usr/bin/env bash
# Works an ultrakanban board with Claude Code for as long as you leave it running, one `claude -p` at a time.
# Several of these loops can work one board together, each in its own checkout (see "Several loops" below).
#
# The loop is the board's agent (its controller), named AGENT. The runs it starts are its workers, and they claim
# tickets under a name made of the agent, the model and the effort level they run with: AGENT/MODEL/EFFORT, e.g.
# claude/opus/high. The loop passes that model and effort to claude, so the name always says what did the work.
# A ticket can ask for its own effort level (its agentEffort); tickets that don't are worked at EFFORT.
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
# the todo column has none left, from the backlog column.
#
# People can drag the agent's tickets around the board too. A ticket someone moves back to the todo column, or to a
# column before it such as a backlog, goes back to the queue: the loop releases it (unassigns it) and forgets its
# state, and it is claimed again from the todo column like any other ticket. While a run is going, the loop checks its
# ticket every TICKET_CHECK_SECONDS, and stops the run when someone else takes the ticket away from the agent: moves it
# back to the queue like that, or to the done or cancelled column, unassigns or reassigns it, or deletes it. Moving a
# ticket into the review column, or tickets the agent doesn't hold, changes nothing for the loop.
#
# Before each run the loop takes a snapshot of what it hands over: the newest ticket activity id, the newest pull
# request comment, review and inline comment ids, and the failing checks and conflict state of the pull request's
# head commit. Only when the run exits successfully does it save that snapshot as the ticket's watermark, in a
# small file per ticket under STATE_DIR. Feedback above the watermark, including anything that arrived during the
# run, starts the next run. A failed run saves nothing and is retried after RETRY_SECONDS, doubling each time, up
# to MAX_ATTEMPTS; new feedback resets the count. A missing or unreadable state file means handling everything
# again, never skipping it.
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
#                       or max (default: high)
#   TODO_COLUMN         column to take new tickets from (default: Todo)
#   BACKLOG_COLUMN      column to take new tickets from when the todo column has none and the board's agentBacklog
#                       setting is on (default: Backlog)
#   IN_PROGRESS_COLUMN  column to move claimed tickets to (default: In progress)
#   CANCELLED_COLUMN    column for tickets whose pull request was closed without merging (default: Cancelled)
#   IDLE_SECONDS        wait between rounds when there is nothing to do (default: 300)
#   TICKET_TIMEOUT      stop a run that takes longer than this, as accepted by timeout(1) (default: 4h)
#   TICKET_CHECK_SECONDS  how often a run's ticket is checked for having been taken away from the agent (default: 30)
#   RETRY_SECONDS       wait before retrying a failed run, doubled after each failure (default: 600)
#   MAX_ATTEMPTS        failed runs in a row before waiting for new feedback (default: 3)
#   MAX_CI_RUNS         runs in a row started only by failing CI, with no human feedback between (default: 2)
#   SKIP_PERMISSIONS    1 passes --dangerously-skip-permissions to claude, 0 doesn't (default: 1)
#   STRICT_MCP          1 passes --strict-mcp-config to claude, so runs load no MCP servers (the account's connectors,
#                       plugins' or the repository's) except those given with --mcp-config in CLAUDE_ARGS: their tools
#                       and instructions are sent with every request of a run. 0 loads them as usual (default: 1)
#   CLAUDE_ARGS         extra arguments for claude; set the model and effort with MODEL and EFFORT, not here
#   STATE_DIR           where watermarks are kept (default: $XDG_STATE_HOME/ultrakanban-agent-loop/BOARD-AGENT)
#   AGENT_LOOP_CLEAN    1 when running in a dedicated clone: before each run the loop fetches, discards local
#                       changes and checks out the default branch (or the pull request's branch for feedback runs).
#                       agent-board.sh sets it. Leave it unset in a working copy of your own.
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
EFFORT=${EFFORT:-high}
WORKER="$AGENT/$MODEL/$EFFORT"
# The effort and name of the run being prepared; use_effort sets them per ticket.
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
# Check output or annotations that mean CI itself didn't run, not that the code failed.
INFRA_PATTERN='billing|spending limit|payments have failed|account is locked|account has been locked'
INFRA_PATTERN+='|was not started|minutes quota|exceeded .*(minutes|quota)'
# What claude prints when the account is out of Claude usage, e.g. "You've hit your session limit · resets 2:50pm
# (America/New_York)".
USAGE_LIMIT_PATTERN="hit your [a-z -]*limit|usage limit|limit reached|out of (extra )?usage"
STATE_DIR=${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ultrakanban-agent-loop/$BOARD-${AGENT//\//_}}
read -r -a claude_args <<<"${CLAUDE_ARGS:-}"
claude_args+=(--model "$MODEL")
if [[ ${SKIP_PERMISSIONS:-1} == 1 ]]; then
  claude_args+=(--dangerously-skip-permissions)
fi
if [[ ${STRICT_MCP:-1} == 1 ]]; then
  claude_args+=(--strict-mcp-config)
fi
mkdir -p "$STATE_DIR" || exit 1

# Finds a ticket's new feedback. Input: its activity, open pull request (gh pr view) or null, the classified checks
# of its head commit (ci_status) or null, pull request comments, reviews and inline comments (GitHub REST), and its
# saved state. Prints the snapshot to save after a successful run, the items to hand over, their fingerprint,
# whether to run now (backoff after failures), and which notes to leave (CI not running, CI run cap reached).
read -r -d '' TRIAGE <<'JQ'
def bot: (.user.type // "") == "Bot" or ((.user.login // "") | endswith("[bot]"));
def feedback: (bot | not) and ((.body // "") | contains($marker) | not);
def ours: . == $agent or . == $loop or startswith($agent + "/");
def clip: if length > 2000 then .[:2000] + " [...]" else . end;
. as [$activity, $pr, $ci, $issue, $reviews, $inline, $s]
| ($pr // {}) as $p
| ($s.checks | if type == "object" then . else {} end) as $seen
| (if $ci != null and $seen.sha == $ci.sha then $seen.names // [] else [] end) as $handedOver
| (($ci.code // []) - $handedOver) as $newFailures
| (if $p.mergeable == "CONFLICTING" or $p.mergeStateStatus == "DIRTY" then "\($p.headRefOid):\($p.baseRefOid)"
   else "" end) as $conflict
| [ ($activity[] | select(.type == "comment" and .id > ($s.activity // 0) and (.actor | ours | not))
      | {key: "t\(.id)", text: "Ticket comment from \(.actor):\n\(.data.body // "" | clip)"}),
    ($activity[] | select(.type == "moved" and .id > ($s.activity // 0) and (.actor | ours | not))
      | select((.data.to // "" | ascii_downcase) == ($working | ascii_downcase))
      | {key: "t\(.id)", text: ("\(.actor) moved the ticket from \(.data.from) to \(.data.to):\n"
         + "They want more work on it. Look for what in their comments on the ticket and the pull request. If they "
         + "don't say, ask them in a ticket comment and leave the ticket in \(.data.to).")}),
    ($issue[] | select(.id > ($s.issue // 0) and feedback)
      | {key: "i\(.id)", text: "Pull request comment from \(.user.login) (\(.html_url)):\n\(.body // "" | clip)"}),
    ($reviews[] | select(.id > ($s.review // 0) and feedback and .state != "PENDING")
      | select(.state != "COMMENTED" or (.body // "") != "")
      | {key: "r\(.id)",
         text: "Pull request review (\(.state)) from \(.user.login) (\(.html_url)):\n\(.body // "" | clip)"}),
    ($inline[] | select(.id > ($s.inline // 0) and feedback)
      | {key: "c\(.id)", text: ("Inline review comment from \(.user.login) "
         + "on \(.path):\(.line // .original_line // "?") (\(.html_url)):\n\(.body // "" | clip)")})
  ] as $human
| [ if $newFailures != [] then
      {key: "checks \($ci.sha):\($newFailures | join(","))",
       text: "Failing checks on \($ci.sha[:7]): \($newFailures | join(", "))"}
    else empty end ] as $ciItems
| (($s.ciRuns // 0) >= $maxci and $human == [] and $ciItems != []) as $capped
| (if $capped then [] else $ciItems end) as $ciUsed
| (if $human != [] then 0 elif $ciUsed != [] then ($s.ciRuns // 0) + 1 else ($s.ciRuns // 0) end) as $ciRuns
| ($ci != null and $ci.infra != [] and $s.infraNoted != $ci.sha) as $infraNote
| ($capped and ($s.capNoted | not)) as $capNote
| {
    snapshot: ({
      activity: ([$activity[].id, $s.activity // 0] | max),
      issue: ([$issue[].id, $s.issue // 0] | max),
      review: ([$reviews[].id, $s.review // 0] | max),
      inline: ([$inline[].id, $s.inline // 0] | max),
      checks: (if $ci == null or $capped then $seen else {sha: $ci.sha, names: ($handedOver + $ci.code | unique)} end),
      conflict: $conflict,
      ciRuns: $ciRuns,
      infraNoted: (if $infraNote then $ci.sha else $s.infraNoted end),
      capNoted: (if $ciRuns != 0 and ($capNote or $s.capNoted == true) then true else null end)
    } | with_entries(select(.value != null))),
    items: ([
      (if $s.claim then {key: "claim", text: ("The previous run on this ticket didn't finish. "
        + "Check what it got done and carry on from there.")} else empty end),
      $human[], $ciUsed[],
      (if $conflict != "" and $conflict != ($s.conflict // "") then
        {key: "conflict \($conflict)", text: "The pull request has merge conflicts with \($p.baseRefName)"}
       else empty end)
    ]),
    ci: ($ciUsed != []),
    ciRuns: $ciRuns,
    infraNote: (if $infraNote then $ci else null end),
    capNote: $capNote
  }
| .fingerprint = (.items | map(.key) | join(" "))
| .run = (.items != [] and (($s.failedFor // null) != .fingerprint or (($s.failures // 0) < $max
    and $now >= ($s.failedAt // 0) + $retry * pow(2; ($s.failures // 1) - 1))))
JQ

# The columns of a board (GET /boards/:id) in which the agent doesn't work tickets, as {id: {name, queued}}: the todo
# column and the columns before it, where tickets wait to be worked (queued), and the done and cancelled columns.
read -r -d '' IDLE_COLUMNS <<'JQ'
def named($name): [.columns[] | select((.name | ascii_downcase) == ($name | ascii_downcase))][0];
(.board.doneColumnId // "") as $done
| (.board.reviewColumnId // "") as $review
| (named($cancelled).id // "") as $cancelledId
| (named($working).id // "") as $workingId
| (named($todo).position // -1) as $todoAt
| [.columns[] | (.id == $done or .id == $cancelledId) as $closed
    | select($closed or (.position <= $todoAt and .id != $review and .id != $workingId))
    | {key: .id, value: {name, queued: ($closed | not)}}]
| from_entries
JQ

# Works the next ticket at the given effort level (the ticket's own), or at EFFORT when it is empty.
use_effort() {
  effort=${1:-$EFFORT}
  worker="$AGENT/$MODEL/$effort"
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

# Classifies the checks on a commit that didn't pass. Only checks that ran and failed are "code" failures, which
# count as feedback. "infra" ones never start a run: startup_failure, action_required, timed_out (usually a hung
# runner, and retrying it tends to loop), failures whose output or annotations mention billing, spending limits or a
# job that was not started, and GitHub Actions jobs in which no step failed (e.g. no step ran at all). Cancelled,
# skipped, neutral and stale checks are ignored. Legacy commit statuses count as code failures for "failure" and as
# infra for "error". Prints {sha, code: [names], infra: [{name, why}]}.
ci_status() {
  local repo=$1 sha=$2 runs statuses id name conclusion app count text why job
  runs=$(gh api --paginate "repos/$repo/commits/$sha/check-runs?filter=latest&per_page=100" </dev/null |
    jq -rs '[.[].check_runs[]] | group_by(.name) | map(max_by(.id))[]
      | select(.status == "completed")
      | select(.conclusion | IN("failure", "timed_out", "startup_failure", "action_required"))
      | [.id, .name, .conclusion, .app.slug // "", .output.annotations_count // 0,
         ([.output.title, .output.summary, .output.text] | map(select(.)) | join(" ") | gsub("[\t\n\r]"; " "))]
      | @tsv') || return 1
  statuses=$(gh api "repos/$repo/commits/$sha/status" </dev/null |
    jq -r '.statuses[]? | select(.state == "failure" or .state == "error")
      | [.context, .state, (.description // "" | gsub("[\t\n\r]"; " "))] | @tsv') || return 1
  {
    while IFS=$'\t' read -r -u 4 id name conclusion app count text; do
      [[ -n $id ]] || continue
      why=
      if [[ $conclusion != failure ]]; then
        why=$conclusion
      else
        if [[ $count != 0 ]]; then
          text+=" $(gh api "repos/$repo/check-runs/$id/annotations" </dev/null | jq -r '[.[].message] | join(" ")')"
        fi
        if grep -qiE "$INFRA_PATTERN" <<<"$text"; then
          why=$(grep -oiE "[^.]*($INFRA_PATTERN)[^.]*" <<<"$text" | head -1)
        elif [[ $app == github-actions ]] && job=$(gh api "repos/$repo/actions/jobs/$id" </dev/null) &&
          ! jq -e 'any(.steps[]?; .conclusion == "failure")' >/dev/null <<<"$job"; then
          why="no step ran and failed"
        fi
      fi
      if [[ -n $why ]]; then printf 'infra\t%s\t%s\n' "$name" "$why"; else printf 'code\t%s\n' "$name"; fi
    done 4<<<"$runs"
    while IFS=$'\t' read -r -u 4 name conclusion text; do
      [[ -n $name ]] || continue
      if [[ $conclusion == error ]] || grep -qiE "$INFRA_PATTERN" <<<"$text"; then
        printf 'infra\t%s\t%s\n' "$name" "status $conclusion: $text"
      else
        printf 'code\t%s\n' "$name"
      fi
    done 4<<<"$statuses"
  } | jq -Rn --arg sha "$sha" '[inputs | split("\t")]
    | {sha: $sha, code: ([.[] | select(.[0] == "code") | .[1]] | unique),
       infra: [.[] | select(.[0] == "infra") | {name: .[1], why: (.[2] | gsub("^\\s+|\\s+$"; ""))}]}'
}

# In a dedicated clone, a run that doesn't finish (it failed, timed out, ran out of Claude usage, or the loop or the
# machine stopped) leaves its work in the checkout, and the next checkout would discard it. So each run records its
# ticket and starting commit in the checkout's git directory (RUN_FILE), and a successful run removes that record.
# While the record is there, the checkout's work belongs to that ticket, and save_work keeps it before anything is
# discarded: its local commits and all its changes, untracked files included, as one commit on top of them, under
# refs/ultrakanban/work/<ticket> (shared by the clone and its worktrees). The commit message names the branch it was on.
run_file() { printf '%s/ultrakanban-run' "$(git rev-parse --git-dir)"; }

save_work() {
  local file id base branch tree commit
  file=$(run_file) || return 1
  [[ -f $file ]] || return 0
  read -r id base <"$file"
  if [[ -n $id ]]; then
    branch=$(git branch --show-current)
    git add -A >/dev/null 2>&1
    if tree=$(git write-tree) && [[ $tree != $(git rev-parse 'HEAD^{tree}') || $(git rev-parse HEAD) != "$base" ]]; then
      commit=$(git commit-tree "$tree" -p HEAD -m "Unfinished work on ticket $id

branch: ${branch:--}") && git update-ref "refs/ultrakanban/work/$id" "$commit" ||
        { log "error: can't keep the unfinished work on $id; it is discarded"; rm -f "$file"; return 0; }
      log "kept the unfinished work on $id (${branch:-detached HEAD}) as refs/ultrakanban/work/$id"
    fi
  fi
  rm -f "$file"
}

# Puts back a ticket's unfinished work saved by save_work: its branch (or a detached HEAD) with its local commits, and
# its changes uncommitted in the working tree. Prints where it is.
restore_work() {
  local ref=refs/ultrakanban/work/$1 branch
  git rev-parse --verify --quiet "$ref" >/dev/null || return 1
  branch=$(git log -1 --format=%B "$ref" | sed -n 's/^branch: //p')
  if [[ -n $branch && $branch != - ]]; then
    git checkout --quiet --ignore-other-worktrees -B "$branch" "$ref" || return 1
  else
    git checkout --quiet --detach "$ref" || return 1
    branch=
  fi
  git reset --quiet 'HEAD~1' || return 1
  git update-ref -d "$ref"
  printf '%s at %s\n' "${branch:+branch }${branch:-a detached HEAD}" "$(git rev-parse --short HEAD)"
}

# In a dedicated clone or worktree (AGENT_LOOP_CLEAN=1, set by agent-board.sh), puts the checkout on an up-to-date
# branch: the given one (a pull request's branch) if it exists on origin, otherwise the default branch, detached so
# that other worktrees can have it too. Local changes are discarded (after save_work keeps those of an unfinished run),
# so this never happens in a normal working copy. Fetches hold a lock in the repository, so loops in worktrees of one
# clone don't fetch at once. Prints the branch.
checkout() {
  local branch=$1 default lock
  if [[ ${AGENT_LOOP_CLEAN:-0} != 1 ]]; then
    git branch --show-current 2>/dev/null
    return 0
  fi
  save_work
  lock=$(git rev-parse --git-common-dir)/ultrakanban-fetch.lock || return 1
  flock "$lock" git fetch --prune --quiet origin || return 1
  default=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) ||
    { flock "$lock" git remote set-head origin --auto >/dev/null &&
      default=$(git symbolic-ref --short refs/remotes/origin/HEAD); } ||
    return 1
  default=${default#origin/}
  [[ -n $branch ]] && git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null || branch=$default
  git rebase --abort >/dev/null 2>&1
  git merge --abort >/dev/null 2>&1
  git reset --quiet --hard && git clean -fdq || return 1
  if [[ $branch == "$default" ]]; then
    git checkout --quiet --detach "origin/$branch" || return 1
  else
    git checkout --quiet --ignore-other-worktrees -B "$branch" "origin/$branch" || return 1
  fi
  printf '%s\n' "$branch"
}

# The tokens a run used, from claude's JSON output (every model it called, subagents included), in all and per model,
# as the body of POST /tickets/:id/usage.
read -r -d '' USAGE <<'JQ'
def total($field): [.[] | .[$field] // 0] | add // 0;
select(.type == "result")
| (if (.modelUsage // {}) != {} then [.modelUsage[]] else [.usage // {} | {
    inputTokens: .input_tokens, outputTokens: .output_tokens,
    cacheReadInputTokens: .cache_read_input_tokens, cacheCreationInputTokens: .cache_creation_input_tokens}]
  end) as $models
| {agent: $agent, inputTokens: ($models | total("inputTokens")), outputTokens: ($models | total("outputTokens")),
   cacheReadTokens: ($models | total("cacheReadInputTokens")),
   cacheWriteTokens: ($models | total("cacheCreationInputTokens")),
   costUsd: .total_cost_usd, durationMs: .duration_ms,
   models: [.modelUsage // {} | to_entries[] | {model: .key, inputTokens: (.value.inputTokens // 0),
     outputTokens: (.value.outputTokens // 0), cacheReadTokens: (.value.cacheReadInputTokens // 0),
     cacheWriteTokens: (.value.cacheCreationInputTokens // 0), costUsd: .value.costUSD}]}
JQ

# When Claude usage resets, from claude's limit message: "... resets 2:50pm (America/New_York)", "... resets Oct 3,
# 9am (...)", or seconds since the epoch after a "|". Prints it in seconds since the epoch, a minute late to be safe,
# or RETRY_SECONDS from now if the message doesn't say or says something that can't be right.
limit_reset() {
  local now when tz at=
  now=$(date +%s)
  if [[ $1 =~ \|([0-9]{10}) ]]; then
    at=${BASH_REMATCH[1]}
  elif [[ $1 =~ resets\ ([^\(]*[^\ \(])(\ \(([^\)]+)\))? ]]; then
    when=${BASH_REMATCH[1]//,/} tz=${BASH_REMATCH[3]}
    if [[ -n $tz ]]; then at=$(TZ=$tz date -d "$when" +%s 2>/dev/null); else at=$(date -d "$when" +%s 2>/dev/null); fi
    # A time of day that passed within the last hour is just now (clocks differ); an earlier one is tomorrow's.
    if [[ -n $at ]] && ((at <= now)); then
      if ((at > now - 3600)); then at=$now; else at=$((at + 86400)); fi
    fi
  fi
  if [[ -z $at ]] || ((at < now || at > now + 8 * 86400)); then
    at=$((now + RETRY_SECONDS))
  else
    at=$((at + 60))
  fi
  printf '%s\n' "$at"
}

# Prints why the agent no longer has a ticket, given the board's IDLE_COLUMNS: someone else moved it to one of them,
# unassigned it or gave it to someone else, or deleted it. Fails while the agent still has it, and when the agent
# moved or released it itself (e.g. to the cancelled column, as the skill says to when its pull request was closed).
taken_away() {
  local id=$1 idle=$2 response ticket why actor
  response=$(curl -s -w '\n%{http_code}' "$KANBAN/api/tickets/$id")
  case ${response##*$'\n'} in
    404)
      echo "the ticket was deleted"
      return 0
      ;;
    200) ticket=${response%$'\n'*} ;;
    *) return 1 ;;
  esac
  why=$(jq -r --argjson idle "$idle" --arg agent "$AGENT" --arg loop "$LOOP_ACTOR" '
    def ours: . == $agent or . == $loop or startswith($agent + "/");
    if $idle[.columnId] then "it was moved to \($idle[.columnId].name)"
    elif .assignee == null then "it was unassigned"
    elif .assignee | ours | not then "it was reassigned to \(.assignee)"
    else empty end' <<<"$ticket") || return 1
  [[ -n $why ]] || return 1
  actor=$(get "/tickets/$id/activity" |
    jq -r '[.[] | select(.type | IN("moved", "claimed", "released"))] | last | .actor // ""') || return 1
  ours "$actor" && return 1
  printf '%s%s\n' "$why" "${actor:+ (by $actor)}"
}

# Checks a run's ticket every TICKET_CHECK_SECONDS while the run (process pid) goes on, and stops the run if someone
# takes the ticket away from the agent, writing why to the given file.
watch_run() {
  local id=$1 pid=$2 file=$3 idle= why
  trap - INT TERM
  if [[ -n $lock_fd ]]; then exec {lock_fd}>&-; fi
  while sleep "$TICKET_CHECK_SECONDS" && kill -0 "$pid" 2>/dev/null; do
    [[ -n $idle ]] || idle=$(idle_columns) || { idle=; continue; }
    why=$(taken_away "$id" "$idle") || continue
    printf '%s\n' "$why" >"$file"
    log "ticket $id: $why; stopping its run"
    kill -TERM "$pid"
    return
  done
}

# Runs claude on a ticket with the given prompt and further arguments (the session to start or resume), prints its
# final message (and keeps it in claude_result, and what it printed to stderr in claude_errors) and reports the tokens
# it used. Returns claude's exit status. If someone takes the ticket away from the agent meanwhile, the run is stopped
# and claude_stopped says why (it is empty otherwise).
run_claude() {
  local id=$1 prompt=$2 output errors stopped code usage response
  shift 2
  output=$(mktemp) && errors=$(mktemp) && stopped=$(mktemp) || return 1
  (
    # Without the ticket lock's descriptor: anything claude leaves running mustn't keep the ticket locked.
    if [[ -n $lock_fd ]]; then exec {lock_fd}>&-; fi
    exec timeout --foreground "$TICKET_TIMEOUT" claude -p ${claude_args[@]+"${claude_args[@]}"} --effort "$effort" \
      --output-format json "$@"
  ) <<<"$prompt" >"$output" 2>"$errors" &
  running=$!
  watch_run "$id" "$running" "$stopped" &
  watcher=$!
  wait "$running"
  code=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  running= watcher=
  claude_stopped=$(<"$stopped")
  claude_errors=$(<"$errors")
  [[ -n $claude_errors ]] && printf '%s\n' "$claude_errors" >&2
  claude_result=$(jq -r '.result // empty' "$output" 2>/dev/null || cat "$output")
  printf '%s\n' "$claude_result"
  if usage=$(jq -ce --arg agent "$worker" "$USAGE" "$output" 2>/dev/null); then
    response=$(post "/tickets/$id/usage" "$usage")
    [[ ${response##*$'\n'} == 201 ]] || log "can't record the token usage of the run on $id: ${response%$'\n'*}"
  fi
  rm -f "$output" "$errors" "$stopped"
  return "$code"
}

new_session_id() { { uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid; } | tr 'A-F' 'a-f'; }

# Runs claude on a ticket. On success saves the snapshot as the ticket's watermark; on failure keeps the old one
# and counts the failure for the backoff.
#
# Each run is a claude session whose id is kept in the ticket's state (with the checkout it ran in) until the run
# ends. A run that didn't end, because the loop or the machine stopped, or that ran out of Claude usage, still has its
# session there, so the next run on the ticket resumes it (claude --resume) with everything the run already knew and
# did. A run that failed or timed out starts a new session instead, as resuming it would likely fail the same way.
# Either way, the unfinished work in the checkout is put back first (save_work, restore_work).
run_on_ticket() {
  local id=$1 prompt=$2 snapshot=$3 fingerprint=$4 ci_runs=${5:-0} branch=${6:-} code limit why state session \
    start=--session-id previous work=
  # Another loop may have run out of Claude usage since this round started.
  paused && return 0
  state=$(read_state "$id")
  session=$(jq -r '.session.id // ""' <<<"$state")
  claude_stopped=
  if branch=$(checkout "$branch"); then
    if [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then
      printf '%s %s\n' "$id" "$(git rev-parse HEAD)" >"$(run_file)"
      work=$(restore_work "$id") && log "ticket $id: put back the unfinished work of its previous run ($work)"
    fi
    if [[ -n $session ]]; then
      start=--resume
      previous=$(jq -r '.session.checkout // ""' <<<"$state")
      prompt="This continues your previous run on ticket $id, which stopped before it finished: $(jq -r \
        '.session.why // "the loop running it was stopped, for example by a restart"' <<<"$state"). Carry on from where \
you left off rather than starting over, and check what is already done (on the ticket, the branch and the pull \
request) before doing it again.$([[ -n $previous && $previous != "$PWD" ]] && printf '%s' "
Earlier in this conversation you worked in $previous. This run is in $PWD, another checkout of the same \
repository: work only in $PWD from now on, and leave $previous alone, as another run may be using it.")
The loop's usual prompt follows.

$prompt"
    else
      session=$(new_session_id)
    fi
    if [[ -n $work ]]; then
      prompt+="

The previous run on this ticket didn't finish, and the loop kept its unfinished work: the repository is on $work, \
with that run's uncommitted changes back in the working tree (see git status and git log). Carry on from there. If the \
pull request's branch has moved on origin since, merge it in."
    elif [[ -n $branch && ${AGENT_LOOP_CLEAN:-0} == 1 && -z $(git branch --show-current) ]]; then
      prompt+="

The repository is checked out at origin/$branch (a detached HEAD, so create your branch from it), freshly updated \
from origin with no local changes."
    elif [[ -n $branch ]]; then
      prompt+="

The repository is checked out on $branch, freshly updated from origin$(
        [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]] && printf '%s' " with no local changes")."
    fi
    update_state "$id" '.session = ($v | fromjson)' \
      "$(jq -nc --arg id "$session" --arg checkout "$PWD" '{id: $id, checkout: $checkout}')"
    run_claude "$id" "$prompt" "$start" "$session"
    code=$?
    if [[ $code == 0 && ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then rm -f "$(run_file)"; fi
    checkout "" >/dev/null # back to the default branch between runs, keeping the work of a run that didn't finish
  else
    code=1
    log "can't update the checkout for $id"
  fi
  if [[ $code == 0 ]]; then
    write_state "$id" "$snapshot"
    return 0
  fi
  if [[ -n $claude_stopped ]]; then
    # Someone took the ticket away from the agent, so this isn't a failure. The next round puts it back in the queue
    # (see requeue) or forgets it.
    update_state "$id" 'del(.session)'
    note "$id" "Stopped the agent's run on this ticket: $claude_stopped."
    return 0
  fi
  if [[ $start == --resume && $claude_errors == *"No conversation found"* ]]; then
    # The session is gone (e.g. claude's history was cleared): start a new one next round, and don't count a failure.
    log "can't resume the session of the previous run on $id; starting a new one"
    update_state "$id" 'del(.session)'
    return 0
  fi
  log "claude exited with status $code on $id"
  if [[ $code != 124 ]] && limit=$(grep -iE -m1 "$USAGE_LIMIT_PATTERN" <<<"$claude_result"); then
    # Out of Claude usage: not the ticket's fault, so it doesn't count as a failure. Nothing can run until the limit
    # resets, so the whole loop waits for that.
    paused_until=$(limit_reset "$limit")
    printf '%s\n' "$paused_until" >"$PAUSE_FILE"
    log "Claude usage limit reached ($limit); waiting until $(date -d "@$paused_until" '+%F %T')"
    update_state "$id" '.session.why = $v' "it ran out of Claude usage"
    note "$id" "Out of Claude usage, so this run stopped. Claude said: \"$limit\". The loop starts no runs on any \
ticket until $(date -d "@$paused_until" '+%-I:%M%P %Z on %b %-d'), then resumes this one where it left off."
    return 0
  fi
  if [[ $code == 124 ]]; then
    why="it ran longer than the $TICKET_TIMEOUT timeout (TICKET_TIMEOUT) and was stopped"
  else
    why="claude exited with status $code"
    [[ -n $claude_result ]] && why+=". Its last output: \"$(tail -n 1 <<<"$claude_result" | cut -c 1-300)\""
  fi
  write_state "$id" "$(read_state "$id" | jq -c --arg fp "$fingerprint" --argjson now "$(date +%s)" \
    --argjson ci "$ci_runs" '. + {failures: (if .failedFor == $fp then (.failures // 0) + 1 else 1 end),
      failedAt: $now, failedFor: $fp, ciRuns: $ci} | del(.session) | if $ci == 0 then del(.capNoted) else . end')"
  note "$id" "Agent run failed: $why. It is retried with backoff, up to $MAX_ATTEMPTS runs in a row; after that, \
new feedback such as a ticket comment retries it."
}

intro() {
  printf '%s' "Use the ultrakanban skill. KANBAN=$KANBAN, BOARD=$BOARD.
Your name (agent field and X-Actor header): $worker. Use exactly this name: it says that you are the $AGENT agent
running $MODEL at $effort effort.
This is a non-interactive run started by scripts/agent-loop.sh: do the work, then exit. Don't wait for review; the loop
starts a new run when feedback arrives. If you need an answer from a human, ask in a ticket comment and exit.
If the ticket's description has a checklist (- [ ] step), check off each step as you finish it with
POST $KANBAN/api/tickets/<id>/checklist/<index> (0-based) instead of editing the description.
End every pull request comment, review and inline reply you post with this exact line, so the loop doesn't mistake
your own replies for feedback:
$MARKER"
}

# Moves a ticket whose pull request was closed without merging to the cancelled column.
cancel() {
  local id=$1 number=$2 pr_url=$3 cancelled=$4 holder=$5 response
  if [[ -z $cancelled ]]; then
    log "error: ticket #$number ($id): $pr_url was closed without merging, but the board has no \
\"$CANCELLED_COLUMN\" column; leaving the ticket alone"
    return 1
  fi
  response=$(post "/tickets/$id/release" "$(jq -nc --arg agent "$holder" --arg moveTo "$cancelled" \
    '{agent: $agent, moveTo: $moveTo}')" "$holder")
  if [[ ${response##*$'\n'} != 200 ]]; then
    log "error: ticket #$number ($id): can't move it to $CANCELLED_COLUMN: ${response%$'\n'*}"
    return 1
  fi
  note "$id" "Pull request $pr_url was closed without merging, so the ticket moved to $CANCELLED_COLUMN."
  rm -f "$(state_file "$id")"
  log "ticket #$number ($id): $pr_url was closed without merging; moved it to $CANCELLED_COLUMN"
}

# Releases a ticket in the todo column or one before it (someone moved it back there), so that it is claimed again
# like any other ticket, and forgets its state and unfinished work.
requeue() {
  local id=$1 number=$2 holder=$3 column=$4 response
  response=$(post "/tickets/$id/release" "$(jq -nc --arg agent "$holder" '{agent: $agent}')" "$holder")
  if [[ ${response##*$'\n'} != 200 ]]; then
    log "error: ticket #$number ($id): can't release it from $column: ${response%$'\n'*}"
    return 1
  fi
  rm -f "$(state_file "$id")"
  if [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then git update-ref -d "refs/ultrakanban/work/$id" 2>/dev/null; fi
  if [[ ${column,,} == "${TODO_COLUMN,,}" ]]; then
    note "$id" "The ticket is back in $column, so the agent released it. It will be claimed again from there like \
any other ticket."
  else
    note "$id" "The ticket was moved to $column, so the agent released it. Move it to $TODO_COLUMN when it should be \
worked on again."
  fi
  log "ticket #$number ($id): moved back to $column; released it"
}

# Reassigns a ticket held under another of the agent's names (another model or effort, or the bare agent name) to
# the worker set by use_effort, in one versioned update.
adopt() {
  local id=$1 number=$2 holder=$3 version=$4 response
  [[ $holder == "$worker" ]] && return 0
  response=$(post "/tickets/$id" "$(jq -nc --arg assignee "$worker" --argjson version "$version" \
    '{assignee: $assignee, ifVersion: $version}')" "$LOOP_ACTOR" PATCH)
  if [[ ${response##*$'\n'} != 200 ]]; then
    log "error: ticket #$number ($id): can't reassign it from $holder to $worker: ${response%$'\n'*}"
    return 1
  fi
  log "ticket #$number ($id): reassigned from $holder to $worker"
}

# Checks the tickets the agent holds and handles the first one that needs work. Returns 1 if none did.
handle_feedback() {
  local board review cancelled idle tickets file id number column holder version ticket_effort pr_url repo pr_number \
    queued pr branch ci issue reviews inline activity state triage items ci_note
  claim_lock -s
  board=$(get "/boards/$BOARD") || { claim_unlock; log "can't read board $BOARD"; return 1; }
  review=$(jq -r '.board.reviewColumnId // ""' <<<"$board")
  cancelled=$(jq -r --arg name "$CANCELLED_COLUMN" \
    '[.columns[] | select((.name | ascii_downcase) == ($name | ascii_downcase)) | .id][0] // ""' <<<"$board")
  idle=$(idle_columns "$board") || { claim_unlock; log "can't read the columns of board $BOARD"; return 1; }
  tickets=$(jq -r --arg agent "$AGENT" --arg cancelled "$cancelled" --argjson idle "$idle" \
    '(.board.doneColumnId // "") as $done
    | .tickets[] | select(.assignee | . != null and (. == $agent or startswith($agent + "/")))
    | select(.columnId != $done and .columnId != $cancelled)
    | [.id, .number, .columnId, .assignee, .version, .agentEffort // "-", .pullRequest.url // "-",
       .pullRequest.repo // "-", .pullRequest.number // "-",
       ($idle[.columnId] | if .queued then .name else "-" end)] | @tsv' \
    <<<"$board")
  board=

  # Forget tickets the agent no longer holds, and their unfinished work.
  for file in "$STATE_DIR"/*.json "$STATE_DIR"/*.lock; do
    [[ -e $file && $file != */claim.lock ]] || continue
    id=${file##*/}
    id=${id%.*}
    [[ $'\n'$tickets == *$'\n'"$id"$'\t'* ]] || rm -f "$file"
  done
  if [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then
    for id in $(git for-each-ref --format='%(refname:lstrip=3)' refs/ultrakanban/work/); do
      [[ $'\n'$tickets == *$'\n'"$id"$'\t'* ]] || git update-ref -d "refs/ultrakanban/work/$id"
    done
  fi
  claim_unlock

  while IFS=$'\t' read -r -u 3 id number column holder version ticket_effort pr_url repo pr_number queued; do
    [[ -n $id ]] || continue
    # Another loop is working this one.
    unlock_ticket
    lock_ticket "$id" || continue
    if [[ $queued != - ]]; then
      requeue "$id" "$number" "$holder" "$queued"
      continue
    fi
    pr=null branch= ci=null issue='[]' reviews='[]' inline='[]'
    if [[ $pr_url != - ]]; then
      pr=$(gh pr view "$pr_url" \
        --json state,mergeable,mergeStateStatus,headRefOid,headRefName,baseRefOid,baseRefName </dev/null) ||
        { log "can't read $pr_url"; continue; }
      case $(jq -r .state <<<"$pr") in
        OPEN)
          branch=$(jq -r .headRefName <<<"$pr")
          issue=$(gh_list "repos/$repo/issues/$pr_number/comments?per_page=100") &&
            reviews=$(gh_list "repos/$repo/pulls/$pr_number/reviews?per_page=100") &&
            inline=$(gh_list "repos/$repo/pulls/$pr_number/comments?per_page=100") ||
            { log "can't read the comments on $pr_url"; continue; }
          ci=$(ci_status "$repo" "$(jq -r .headRefOid <<<"$pr")") ||
            { log "can't read the checks on $pr_url"; continue; }
          ;;
        CLOSED)
          if [[ $column == "$review" ]]; then
            cancel "$id" "$number" "$pr_url" "$cancelled" "$holder" && { unlock_ticket; return 0; }
            continue
          fi
          pr=null
          ;;
        *) pr=null ;;
      esac
    fi

    activity=$(get "/tickets/$id/activity") || { log "can't read the activity of $id"; continue; }
    state=$(read_state "$id")
    triage=$(printf '%s\n' "$activity" "$pr" "$ci" "$issue" "$reviews" "$inline" "$state" |
      jq -cs --arg agent "$AGENT" --arg loop "$LOOP_ACTOR" --arg marker "$MARKER" --arg working "$IN_PROGRESS_COLUMN" \
        --argjson now "$(date +%s)" --argjson retry "$RETRY_SECONDS" --argjson max "$MAX_ATTEMPTS" \
        --argjson maxci "$MAX_CI_RUNS" "$TRIAGE") ||
      { log "can't triage $id"; continue; }
    activity= pr= ci= issue= reviews= inline=

    if [[ $(jq -r '.infraNote != null' <<<"$triage") == true ]]; then
      ci_note=$(jq -r '.infraNote | "CI on \(.sha[:7]) didn'"'"'t run properly, so no agent run was started for it: "
        + (.infra | map("\(.name) (\(.why))") | join("; "))' <<<"$triage")
      log "ticket #$number ($id): $ci_note"
      note "$id" "$ci_note. Someone needs to check CI (billing and spending limits, runners, approvals)."
      update_state "$id" '.infraNoted = $v' "$(jq -r .infraNote.sha <<<"$triage")"
    fi
    if [[ $(jq -r .capNote <<<"$triage") == true ]]; then
      log "ticket #$number ($id): $MAX_CI_RUNS runs in a row for failing CI; not starting more until a human comments"
      note "$id" "The agent made $MAX_CI_RUNS runs in a row for failing CI with no human feedback in between, so the \
loop stopped starting runs for CI on this ticket. Comment on the ticket to let it try again."
      update_state "$id" '.capNoted = true'
    fi
    [[ $(jq -r .run <<<"$triage") == true ]] || continue

    use_effort "${ticket_effort#-}"
    adopt "$id" "$number" "$holder" "$version" || continue
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
If the ticket isn't in review yet, keep working it and submit it for review, unless the feedback above says
otherwise.$(
      [[ $(jq -r .ci <<<"$triage") == true ]] && printf '%s' "
Failing CI started this run. First find out from the failing job's log whether the failure comes from the code. If it
doesn't (billing or spending limits, runners or infrastructure, a flaky test unrelated to the change, missing
secrets), don't push anything: explain what you found in the ticket comment and exit.")
Finish with a ticket comment summarising what you did, then exit." \
      "$(jq -c .snapshot <<<"$triage")" "$(jq -r .fingerprint <<<"$triage")" "$(jq -r .ciRuns <<<"$triage")" "$branch"
    unlock_ticket
    return 0
  done 3<<<"$tickets"
  unlock_ticket
  return 1
}

# Whether the board lets the agent take tickets from the backlog column, and has that column.
backlog_on() {
  get "/boards/$BOARD" | jq -e --arg name "$BACKLOG_COLUMN" \
    '.board.agentBacklog and any(.columns[]; (.name | ascii_downcase) == ($name | ascii_downcase))' >/dev/null
}

# Claims the next ticket from the given column; prints the response body and then the HTTP status on its own line.
claim_from() {
  post "/boards/$BOARD/tickets/claim-next" "$(jq -nc --arg agent "$worker" --arg column "$1" \
    --arg moveTo "$IN_PROGRESS_COLUMN" '{agent: $agent, column: $column, moveTo: $moveTo}')"
}

# Claims the next ticket from the todo column (then the backlog column, if the board allows it) and works it.
# Returns 1 if there was nothing to claim.
claim_next() {
  local response status ticket id snapshot
  paused && return 0
  use_effort ""
  claim_lock -x
  response=$(claim_from "$TODO_COLUMN")
  status=${response##*$'\n'}
  ticket=${response%$'\n'*}
  if [[ $status == 404 && $ticket == *no_ticket_available* ]] && backlog_on; then
    response=$(claim_from "$BACKLOG_COLUMN")
    status=${response##*$'\n'}
    ticket=${response%$'\n'*}
  fi
  if [[ $status != 200 ]]; then
    claim_unlock
    [[ $status == 404 && $ticket == *no_ticket_available* ]] || log "claim failed (HTTP ${status:-none}): $ticket"
    return 1
  fi

  id=$(jq -r .id <<<"$ticket")
  log "ticket #$(jq -r .number <<<"$ticket") ($id): claimed: $(jq -r .title <<<"$ticket")"
  if ! lock_ticket "$id"; then
    # Can't happen while every loop takes the claim lock; leave the ticket to whichever loop has it.
    claim_unlock
    log "ticket #$(jq -r .number <<<"$ticket") ($id): another loop is already working it"
    return 0
  fi
  # The claim can't know the ticket's effort beforehand, so a ticket that sets one is handed to that worker now.
  use_effort "$(jq -r '.agentEffort // ""' <<<"$ticket")"
  adopt "$id" "$(jq -r .number <<<"$ticket")" "$WORKER" "$(jq -r .version <<<"$ticket")" || use_effort ""
  # Everything on the ticket so far is handed to this run. Until it succeeds, the claim itself counts as feedback,
  # so a failed or interrupted run is retried with backoff.
  snapshot=$(get "/tickets/$id/activity" | jq -c '{activity: (map(.id) | max // 0)}') || snapshot='{}'
  write_state "$id" "$(jq -c '. + {claim: true}' <<<"$snapshot")"
  claim_unlock
  run_on_ticket "$id" "$(intro)

Ticket $id is already claimed for you and in progress. Work only this ticket; do not claim another.
Take it through to review and exit after submitting it." "$snapshot" "claim"
  unlock_ticket
  return 0
}

# Waits the given number of seconds in the background, so a signal ends the wait at once.
pause() {
  sleep "$1" &
  sleeper=$!
  wait "$sleeper"
  sleeper=
}

sleeper=
# Set when Claude usage runs out: no run starts before this time (seconds since the epoch). Kept in PAUSE_FILE, so
# the other loops working the board wait too.
paused_until=0
# The run in progress and the process watching its ticket (see run_claude), if any.
running=
watcher=
trap 'log "stopped"; kill $sleeper $running $watcher 2>/dev/null; exit 0' INT TERM

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

log "working board $BOARD as $AGENT, claiming tickets as $WORKER (or at the effort a ticket asks for)"
# A run stopped along with the loop left its work here; keep it now, so whichever loop resumes the ticket gets it back.
if [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then save_work; fi
while true; do
  paused && pause "$((paused_until - $(date +%s)))"
  if [[ $(watched) != "$watching" ]]; then
    log "the agent scripts were updated; stopping to start again with the new ones"
    exit 75
  fi
  handle_feedback || claim_next || pause "$IDLE_SECONDS"
done
