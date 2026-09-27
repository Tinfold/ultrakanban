# Running claude on a ticket: token usage, the usage limit, watching the ticket, and the prompt.
# Part of agent-loop.sh, which sources it; the settings it uses are described there.

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

# The skills the next run gets, as arguments for claude (skill_args): only the ultrakanban skill, in the system prompt,
# unless the board's agentAllSkills is on or the repository has skills or commands of its own.
use_skills() {
  local skill=.claude/skills/ultrakanban/SKILL.md
  skill_args=()
  [[ -f $skill ]] || return 0
  if [[ -n $(find .claude/commands .claude/skills -mindepth 1 -maxdepth 1 ! -path "${skill%/*}" -print -quit \
    2>/dev/null) ]] || get "/boards/$BOARD" | jq -e .board.agentAllSkills >/dev/null; then
    return 0
  fi
  skill_args=(--disable-slash-commands --append-system-prompt "This run has no Skill tool: the ultrakanban skill it \
uses is already loaded, here.

$(<"$skill")")
}

# Runs claude on a ticket with the given prompt and further arguments (the session to start or resume), prints its
# final message (and keeps it in claude_result, and what it printed to stderr in claude_errors) and reports the tokens
# it used. Returns claude's exit status. If someone takes the ticket away from the agent meanwhile, the run is stopped
# and claude_stopped says why (it is empty otherwise).
run_claude() {
  local id=$1 prompt=$2 output errors stopped code usage response
  shift 2
  output=$(mktemp) && errors=$(mktemp) && stopped=$(mktemp) || return 1
  use_skills
  (
    # Without the ticket lock's descriptor: anything claude leaves running mustn't keep the ticket locked.
    if [[ -n $lock_fd ]]; then exec {lock_fd}>&-; fi
    exec timeout --foreground "$TICKET_TIMEOUT" claude -p ${claude_args[@]+"${claude_args[@]}"} \
      ${skill_args[@]+"${skill_args[@]}"} --model "$model" --effort "$effort" --output-format json "$@"
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
running $model at $effort effort.
This is a non-interactive run started by scripts/agent-loop.sh: do the work, then exit. Don't wait for review; the loop
starts a new run when feedback arrives. If you need an answer from a human, ask in a ticket comment and exit.
If the ticket's description has a checklist (- [ ] step), check off each step as you finish it with
POST $KANBAN/api/tickets/<id>/checklist/<index> (0-based) instead of editing the description.
End every pull request comment, review and inline reply you post with this exact line, so the loop doesn't mistake
your own replies for feedback:
$MARKER"
}
