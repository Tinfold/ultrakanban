# Running claude on a ticket: what the run did, token usage, the usage limit, watching the ticket, and the prompt.
# Part of agent-loop.sh, which sources it; the settings it uses are described there.

# What the loop needs from a run's output, read in one pass. Claude writes stream-json: one JSON object per line as
# the run goes (its init, each message of the model and each tool result, then a final `"type": "result"` object with
# the final message, turns, cost and usage). The output can be many megabytes, as tool results are in it, so this
# keeps only what is needed, small enough to handle as a whole:
#   result  the final result object, or null when the run ended without one (it timed out or was killed)
#   text    the run's last text message, for a run without a result
#   output  what claude printed that isn't JSON, such as an error before the run started (at most 50 lines)
#   turns   how many responses the model gave, for a run without a result (parallel tool calls share one)
#   steps   the run's tool calls in order as {tool, summary, error}, for its record: not its subagents' (the Agent
#           call that started one is a step), the summary a short target for people (a command's first line, less a
#           leading cd to the checkout, a file's path relative to the checkout $cwd, a search pattern), error whether
#           the tool reported one
# Lines that don't parse are skipped, such as the last one when claude was killed while writing it, and every field is
# optional, so an older or newer claude still gives what it can. STEP_SUMMARY is the short target of a tool call
# (tool_use block), shared with RUN_STEP.
read -r -d '' STEP_SUMMARY <<'JQ'
def clip($n): if length > $n then .[:($n - 1)] + "…" else . end;
def path: ltrimstr($cwd + "/") | if length > 120 then "…" + .[(length - 119):] else . end;
# A command without the `cd` to the checkout it starts with, if it does, which agents often put before each command.
def nocd:
  first(capture("^\\s*cd +(?<dir>[^;&|]+?) *(;|&&) *(?<rest>.*)$")
    | select(.dir | IN($cwd, "\"\($cwd)\"", "$PWD", "\"$PWD\"", ".")) | .rest) // .;
def summary:
  ((.input | objects) // {}) as $in
  | if .name == "Bash" then $in.command // "" | split("\n") | .[0] // "" | nocd
    elif .name | IN("Read", "Edit", "MultiEdit", "Write") then $in.file_path // "" | path
    elif .name == "NotebookEdit" then $in.notebook_path // "" | path
    elif .name | IN("Grep", "Glob") then
      ($in.pattern // "") + (if $in.path then " in \($in.path | tostring | path)" else "" end)
    elif .name == "WebFetch" then $in.url // ""
    elif .name == "WebSearch" then $in.query // ""
    elif .name | IN("Task", "Agent") then $in.description // ""
    elif .name == "Skill" then $in.skill // $in.command // ""
    elif .name == "TodoWrite" then [$in.todos[]? | objects | select(.status == "in_progress") | .content][0] // ""
    else [$in[] | strings][0] // "" end
  | tostring | gsub("\\s+"; " ") | clip(120);
JQ
read -r -d '' RUN_SUMMARY <<'JQ'
reduce (inputs | . as $line | try fromjson catch $line) as $event (
  {result: null, text: null, output: [], turns: 0, message: null, steps: [], failed: {}};
  if ($event | type) == "string" then
    if ($event | test("^\\s*[{\\[]|^\\s*$") | not) and (.output | length) < 50 then .output += [$event] else . end
  elif ($event | type) != "object" then .
  elif $event.type == "result" then .result = $event
  elif $event.type == "assistant" and $event.parent_tool_use_id == null then
    (if $event.message.id != .message then .turns += 1 | .message = $event.message.id else . end)
    | reduce ($event.message.content // [] | .[] | objects) as $block (.;
        if $block.type == "tool_use" then
          .steps += [{id: $block.id, tool: ($block.name // "unknown"), summary: ($block | summary)}]
        elif $block.type == "text" and ($block.text // "" | test("\\S")) then .text = $block.text
        else . end)
  elif $event.type == "user" then
    .failed += ([$event.message.content[]? | objects | select(.type == "tool_result" and .is_error == true)
      | {key: .tool_use_id, value: true}] | from_entries)
  else . end)
| .failed as $failed
| .steps |= map({tool, summary, error: ($failed[.id] // false)})
| del(.failed, .message)
JQ
RUN_SUMMARY="$STEP_SUMMARY
$RUN_SUMMARY"

# What a run that is going on is doing right now, for its heartbeat's step: its latest tool call as "Tool: target"
# (e.g. "Bash: npm test"), not its subagents' (while one works, the Agent call that started it). Reads claude's output
# backwards (tac), so it stops at the latest call however long the output is; prints nothing before the first one.
read -r -d '' RUN_STEP <<'JQ'
first(inputs | try fromjson catch null | objects | select(.type == "assistant" and .parent_tool_use_id == null)
  | [.message.content[]? | objects | select(.type == "tool_use")] | last // empty
  | (.name // "unknown") + (summary | if . == "" then "" else ": " + . end) | clip(200)) // empty
JQ
RUN_STEP="$STEP_SUMMARY
$RUN_STEP"

# Prints the latest tool call of the run whose output (claude's stream-json) is in the given file (see RUN_STEP).
current_step() {
  tac "$1" 2>/dev/null | grep -F '"parent_tool_use_id":null' | grep -F '"type":"tool_use"' |
    jq -nRr --arg cwd "$PWD" "$RUN_STEP" 2>/dev/null
}

# A run's record, the body of POST /tickets/:id/runs (see RunRecord in shared/domain.ts), from RUN_SUMMARY's output
# and what the loop knows: $outcome, the exit $code, the $duration in ms, the run's $usage (USAGE's output, or null)
# for its cost, whether it went on the agents' API key ($apiKey), and the end of what claude printed to stderr
# ($errors), the message of a run that left no other.
# The message is clipped to 4000 characters (RUN_MESSAGE_MAX), and a run of more than 150 tool calls (RUN_MAX_STEPS)
# keeps its first and last 75, saying how many were left out between them.
read -r -d '' RUN_RECORD <<'JQ'
def clip($n): if length > $n then .[:($n - 1)] + "…" else . end;
75 as $half
| (.steps // []) as $steps
| ($steps | length) as $count
| {agent: $agent, outcome: $outcome, exitCode: $code, durationMs: $duration,
   turns: (.result.num_turns // .turns // null), costUsd: (($usage | objects | .costUsd) // null), apiKey: $apiKey,
   message: (((.result.result // .text // (.output // [] | join("\n"))) | strings | select(test("\\S"))) // $errors
     | clip(4000)),
   steps: (if $count > 2 * $half then $steps[:$half] + $steps[($count - $half):] else $steps end),
   omittedSteps: (if $count > 2 * $half then {after: $half, count: ($count - 2 * $half)} else null end)}
JQ

# The tokens a run used, from the result object of claude's output (every model it called, subagents included), in all
# and per model, as the body of POST /tickets/:id/usage. Claude prices models it doesn't know (another provider's, or
# a local one, through ANTHROPIC_BASE_URL) as if they were Opus and says so with costBasis "unknown": those costs are
# left out. $apiKey says whether the run went on the agents' API key, its cost then billed rather than estimated.
read -r -d '' USAGE <<'JQ'
def total($field): [.[] | .[$field] // 0] | add // 0;
def cost: if .costBasis == "unknown" then null else .costUSD end;
select(.type == "result")
| (if (.modelUsage // {}) != {} then [.modelUsage[]] else [.usage // {} | {
    inputTokens: .input_tokens, outputTokens: .output_tokens,
    cacheReadInputTokens: .cache_read_input_tokens, cacheCreationInputTokens: .cache_creation_input_tokens}]
  end) as $models
| {agent: $agent, inputTokens: ($models | total("inputTokens")), outputTokens: ($models | total("outputTokens")),
   cacheReadTokens: ($models | total("cacheReadInputTokens")),
   cacheWriteTokens: ($models | total("cacheCreationInputTokens")),
   costUsd: (if any(.modelUsage // {} | .[]; .costBasis == "unknown") then [.modelUsage[] | cost // empty] | add
     else .total_cost_usd end),
   durationMs: .duration_ms, apiKey: $apiKey,
   models: [.modelUsage // {} | to_entries[] | {model: .key, inputTokens: (.value.inputTokens // 0),
     outputTokens: (.value.outputTokens // 0), cacheReadTokens: (.value.cacheReadInputTokens // 0),
     cacheWriteTokens: (.value.cacheCreationInputTokens // 0), costUsd: (.value | cost)}]}
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

# Prints why the run on a ticket must stop, from one look at the ticket (GET /tickets/:id), given the board's
# IDLE_COLUMNS. That is a kind and a text, separated by a tab:
#   taken      why the agent no longer has the ticket: someone else moved it to one of those columns, unassigned it or
#              gave it to someone else, or deleted it
# (A request to stop the run, POST /tickets/:id/stop, comes back with the heartbeat: see watch_run.)
# Fails while the run may go on, including when the agent moved or released the ticket itself (e.g. to the cancelled
# column, as the skill says to when its pull request was closed).
stop_reason() {
  local id=$1 idle=$2 response ticket why actor by
  response=$(curl -s -w '\n%{http_code}' "$KANBAN/api/tickets/$id")
  case ${response##*$'\n'} in
    404)
      printf 'taken\t%s\n' "the ticket was deleted"
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
  if [[ -n $why ]]; then
    actor=$(get "/tickets/$id/activity" |
      jq -r '[.[] | select(.type | IN("moved", "claimed", "released"))] | last | .actor // ""') || return 1
    if ! ours "$actor"; then
      printf 'taken\t%s%s\n' "$why" "${actor:+ (by $actor)}"
      return 0
    fi
  fi
  return 1
}

# Checks a run's ticket every TICKET_CHECK_SECONDS while the run (process pid) goes on, and stops the run if someone
# takes the ticket away from the agent or asks for the run to stop, writing why to the given file (see stop_reason).
# Each check also tells the board the agent is working on the ticket, so the board doesn't count it as idle. Every
# RUN_STEP_SECONDS it also reads the run's latest tool call from its output file (see current_step), and tells the
# board when it changed, so the ticket shows what the run does as it goes.
watch_run() {
  local id=$1 pid=$2 file=$3 output=$4 idle= reason step due checked=$SECONDS interval=$TICKET_CHECK_SECONDS
  trap - INT TERM
  if [[ -n $lock_fd ]]; then exec {lock_fd}>&-; fi
  ((RUN_STEP_SECONDS > 0 && RUN_STEP_SECONDS < interval)) && interval=$RUN_STEP_SECONDS
  heartbeat "$id"
  while sleep "$interval" && kill -0 "$pid" 2>/dev/null; do
    due=$((SECONDS - checked >= TICKET_CHECK_SECONDS))
    step=
    ((RUN_STEP_SECONDS > 0)) && step=$(current_step "$output")
    if [[ -n $step && $step != "$run_step" ]]; then
      run_step=$step
    elif ((!due)); then
      continue
    fi
    heartbeat "$id"
    if [[ -n $stop_requested_by ]]; then
      printf 'requested\t%s\n' "$stop_requested_by" >"$file"
      log "ticket $id: $stop_requested_by asked for its run to stop; stopping it"
      kill -TERM "$pid"
      return
    fi
    ((due)) || continue
    checked=$SECONDS
    [[ -n $idle ]] || idle=$(idle_columns) || { idle=; continue; }
    reason=$(stop_reason "$id" "$idle") || continue
    printf '%s\n' "$reason" >"$file"
    log "ticket $id: ${reason#*$'\t'}; stopping its run"
    kill -TERM "$pid"
    return
  done
}

# Keeps the machine from suspending or going idle while the run (process pid) for the given ticket goes on, so it
# isn't paused halfway: a systemd-logind inhibitor lock, released by itself when the run ends. Not taken with
# INHIBIT_SLEEP=0 or without systemd-inhibit; a lock that can't be taken doesn't hold up the run.
inhibit_sleep() {
  [[ $INHIBIT_SLEEP == 1 ]] && command -v systemd-inhibit >/dev/null || return 0
  (
    if [[ -n $lock_fd ]]; then exec {lock_fd}>&-; fi
    exec systemd-inhibit --what=sleep:idle --mode=block --who="ultrakanban agent $AGENT" \
      --why="working on ticket $1" tail --pid="$2" -f /dev/null
  ) </dev/null >/dev/null 2>&1 &
}

# A ticket's scratch directory: its runs' TMPDIR, under STATE_DIR on disk. Agents otherwise leave clones, builds and
# test output in /tmp, which is often held in memory (tmpfs) and never cleaned up, so it ends up filling swap for good.
# It is removed when a run on the ticket finishes (remove_scratch), and kept for the next run when the run is resumed.
scratch_dir() { printf '%s/tmp/%s' "$STATE_DIR" "$1"; }

# Creates the given ticket's scratch directory and prints it. Removes the scratch directories no run has used for 3
# days first: those of tickets the agent no longer works, or whose run stopped and was never resumed. (A run lasts at
# most TICKET_TIMEOUT, and each one touches its directory as it starts.)
make_scratch() {
  local dir
  dir=$(scratch_dir "$1")
  find "$STATE_DIR/tmp" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf {} + 2>/dev/null
  mkdir -p "$dir" && touch "$dir" && printf '%s\n' "$dir"
}

remove_scratch() { rm -rf "$(scratch_dir "$1")"; }

# Stops what a run left running when it ended, such as a dev server it started in the background: every process
# that still has the run's ULTRAKANBAN_RUN marker in its environment, including those that left its process group.
stop_leftovers() {
  local id=$1 run=$2 proc pid pids=() left i
  for proc in /proc/[0-9]*; do
    [[ -O $proc ]] && grep -qzxF "ULTRAKANBAN_RUN=$run" "$proc/environ" 2>/dev/null && pids+=("${proc#/proc/}")
  done
  ((${#pids[@]})) || return 0
  log "ticket $id: stopping what its run left running: $(ps -o comm= -p "$(IFS=,; echo "${pids[*]}")" |
    sort -u | paste -sd, -)"
  kill -TERM "${pids[@]}" 2>/dev/null
  for i in 1 2 3 4 5; do
    left=()
    for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && left+=("$pid"); done
    ((${#left[@]})) || return 0
    sleep 1
  done
  kill -KILL "${left[@]}" 2>/dev/null
}

# The skills the next run gets, as arguments for claude (skill_args): only the ultrakanban skill, in the system prompt
# (the short WORKER.md next to SKILL.md when there is one, which leaves out filing and splitting tickets), unless the board's agentAllSkills is on or the repository has skills or commands of its own.
use_skills() {
  local skill=.claude/skills/ultrakanban/SKILL.md
  skill_args=()
  [[ -f $skill ]] || return 0
  if [[ -n $(find .claude/commands .claude/skills -mindepth 1 -maxdepth 1 ! -path "${skill%/*}" -print -quit \
    2>/dev/null) ]] || board | jq -e .board.agentAllSkills >/dev/null; then
    return 0
  fi
  [[ -f ${skill%/*}/WORKER.md ]] && skill=${skill%/*}/WORKER.md
  skill_args=(--disable-slash-commands --append-system-prompt "This run has no Skill tool: the ultrakanban skill it \
uses is already loaded, here.

$(<"$skill")")
}

# The image runs use in Docker when DOCKER_IMAGE isn't set: the tools the loop gives a run on the machine (claude,
# git, gh, jq, curl) and Node.js. Built the first time a run needs it.
read -r -d '' DOCKERFILE <<'DOCKERFILE'
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends gh jq ripgrep && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code && npm cache clean --force
DOCKERFILE

# Whether the ticket's runs go in a Docker container, as the command claude is started with (docker_args): the ticket's
# agentDocker, or the board's when the ticket doesn't set it. Empty runs claude directly on the machine. Returns 1, with
# why in docker_error, if the container can't be set up.
#
# The container sees the checkout (and, for a worktree, the clone's .git) at the same path, and the agent's Claude,
# GitHub and git settings, so claude logs in, resumes sessions, pushes and opens pull requests as it does on the
# machine; nothing else of the home directory. It runs as the agent's user, on the host's network to reach the board,
# and is removed when the run ends. GitHub's token goes in GH_TOKEN, as gh can't reach the machine's keyring from there.
# With podman, the container keeps the agent's user id (rootless podman maps it to root otherwise) and runs without
# SELinux labels, which would deny it the mounted files.
use_docker() {
  local id=$1 setting git_dir home=$HOME path extra
  docker_args=() docker_error=
  setting=$(get "/tickets/$id" | jq -r 'if .agentDocker == null then empty else .agentDocker end')
  [[ -n $setting ]] || setting=$(board | jq -r '.board.agentDocker // false')
  [[ $setting == true ]] || return 0
  if ! "$DOCKER" image inspect "$DOCKER_IMAGE" >/dev/null 2>&1; then
    if [[ $DOCKER_IMAGE != ultrakanban-agent ]]; then
      docker_error="the Docker image $DOCKER_IMAGE (DOCKER_IMAGE) doesn't exist"
    else
      log "building the Docker image $DOCKER_IMAGE"
      "$DOCKER" build --quiet --tag "$DOCKER_IMAGE" - <<<"$DOCKERFILE" >/dev/null ||
        docker_error="can't build the Docker image $DOCKER_IMAGE with $DOCKER"
    fi
    [[ -z $docker_error ]] || { log "$docker_error"; return 1; }
  fi
  docker_args=("$DOCKER" run --rm --interactive --init --name "$(container "$id")" --network host
    --user "$(id -u):$(id -g)" --workdir "$PWD" --env HOME="$home" --env KANBAN --env BOARD
    --env CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS --env BASH_MAX_OUTPUT_LENGTH
    --mount "type=tmpfs,destination=$home,tmpfs-mode=1777" --mount "type=bind,source=$PWD,destination=$PWD")
  git_dir=$(readlink -f "$(git rev-parse --git-common-dir 2>/dev/null)")
  if [[ -n $git_dir && $git_dir != "$PWD"/* ]]; then
    docker_args+=(--mount "type=bind,source=$git_dir,destination=$git_dir")
  fi
  for path in .claude .claude.json .config/gh .gitconfig .config/git; do
    [[ -e $home/$path ]] && docker_args+=(--mount "type=bind,source=$home/$path,destination=$home/$path")
  done
  if "$DOCKER" --version 2>/dev/null | grep -qi podman; then
    docker_args+=(--security-opt label=disable)
    [[ $("$DOCKER" info --format '{{.Host.Security.Rootless}}' 2>/dev/null) == true ]] && docker_args+=(--userns keep-id)
  fi
  [[ -n ${GH_TOKEN:-} ]] || GH_TOKEN=$(gh auth token 2>/dev/null) || GH_TOKEN=
  [[ -n $GH_TOKEN ]] && export GH_TOKEN && docker_args+=(--env GH_TOKEN)
  # Claude's API key, and the endpoint that serves another provider's or a local model and its token
  # (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN), when they are set.
  while read -r name; do docker_args+=(--env "$name"); done < <(compgen -e | grep '^ANTHROPIC_')
  read -r -a extra <<<"${DOCKER_ARGS:-}"
  docker_args+=(${extra[@]+"${extra[@]}"} "$DOCKER_IMAGE")
}

# The name of the container a run on the given ticket goes in.
container() { printf 'ultrakanban-%s-%s-%s' "$BOARD" "$1" "$$"; }

# How a run that exited with the given status ended, for its record (see RunOutcome in shared/domain.ts), from
# claude_stop_requested, claude_stopped and claude_result: in the order run_on_ticket looks at them, so the record says
# what the loop did.
run_outcome() {
  if (($1 == 0)); then
    echo finished
  elif [[ -n $claude_stop_requested ]]; then
    echo stop_requested
  elif [[ -n $claude_stopped ]]; then
    echo stopped
  elif (($1 == 124)); then
    echo timed_out
  elif (($1 > 128)); then
    echo killed
  elif grep -qiE "$USAGE_LIMIT_PATTERN" <<<"$claude_result"; then
    echo usage_limit
  else
    echo failed
  fi
}

# Records a run on the ticket, given its exit status, RUN_SUMMARY's output, its usage (or null) and how long it took in
# ms, with POST /tickets/:id/runs, so the ticket's activity shows what the run did and how it ended. Every run is
# recorded, whether or not it left a result or its usage could be reported.
record_run() {
  local id=$1 code=$2 summary=$3 usage=$4 duration=$5 record response
  record=$(jq -c --arg agent "$worker" --arg outcome "$(run_outcome "$code")" --argjson code "$code" \
    --argjson duration "$duration" --argjson usage "$usage" --arg errors "$(tail -n 20 <<<"$claude_errors")" \
    --argjson apiKey "$([[ -n $api_key_budget ]] && echo true || echo false)" "$RUN_RECORD" <<<"$summary") || { log "can't make the record of the run on $id"; return 1; }
  response=$(post "/tickets/$id/runs" "$record")
  [[ ${response##*$'\n'} == 201 ]] || log "can't record the run on $id: ${response%$'\n'*}"
}

# Runs claude on a ticket with the given prompt and further arguments (the session to start or resume), telling the
# board it is going on and what it does (run_step, see heartbeat) until it ends. Prints its
# final message (and keeps it in claude_result, and what it printed to stderr in claude_errors), reports the tokens
# it used and records what it did on the ticket (record_run). Returns claude's exit status. If someone takes the ticket
# away from the agent meanwhile, the run is stopped and claude_stopped says why; if someone asks for the run to stop, it
# is stopped and claude_stop_requested says who asked (both are empty otherwise). A run stopped either way returns a
# failure, whatever claude exited with. With api_key_budget set (see use_api_key), the run goes on the agents' API key
# (AGENT_API_KEY, as claude's ANTHROPIC_API_KEY) and may spend at most that many dollars; other runs never see the key.
# claude_subtype is the subtype of the run's result, e.g. error_max_budget_usd for one that reached that cap.
run_claude() {
  local id=$1 prompt=$2 output errors stopped code usage=null response scratch= run started summary kind= reason= \
    budget_args=()
  shift 2
  output=$(mktemp) && errors=$(mktemp) && stopped=$(mktemp) || return 1
  use_skills
  if ! use_docker "$id"; then
    claude_stopped= claude_stop_requested= claude_errors= claude_subtype= claude_result="Can't run it in Docker: $docker_error."
    rm -f "$output" "$errors" "$stopped"
    return 1
  fi
  if [[ -n $api_key_budget ]]; then
    budget_args=(--max-budget-usd "$api_key_budget")
    # The container gets the key from the environment, as an option before the image.
    if ((${#docker_args[@]})); then
      docker_args=("${docker_args[@]:0:${#docker_args[@]}-1}" --env ANTHROPIC_API_KEY "${docker_args[-1]}")
    fi
  fi
  # A run in a container has its own /tmp, which goes with the container.
  if ! ((${#docker_args[@]})) && scratch=$(make_scratch "$id"); then
    prompt+="

Put scratch files (clones, builds, test output, screenshots) in \$TMPDIR ($scratch), not in /tmp: /tmp may be held \
in memory and is never cleaned up. \$TMPDIR is on disk, and the loop empties it once the ticket's run finishes."
  fi
  # The board's agentMaxTurns, when set, caps how many turns the run may take.
  max_turns=$(get "/boards/$BOARD" | jq -r '.board.agentMaxTurns // empty' 2>/dev/null)
  [[ $max_turns =~ ^[0-9]+$ ]] || max_turns=
  run=$(new_session_id)
  started=$(date +%s%3N)
  (
    # Without the ticket lock's descriptor: anything claude leaves running mustn't keep the ticket locked.
    if [[ -n $lock_fd ]]; then exec {lock_fd}>&-; fi
    # The marker stop_leftovers looks for, inherited by everything the run starts.
    export ULTRAKANBAN_RUN=$run
    if [[ -n $scratch ]]; then export TMPDIR=$scratch; fi
    # The agents' API key reaches only a run that goes on it, as claude's own.
    if [[ -n $api_key_budget ]]; then export ANTHROPIC_API_KEY=$AGENT_API_KEY; fi
    unset AGENT_API_KEY
    exec timeout --foreground -k "${TICKET_KILL_AFTER:-30}" "$TICKET_TIMEOUT" ${docker_args[@]+"${docker_args[@]}"} claude -p ${claude_args[@]+"${claude_args[@]}"} \
      ${skill_args[@]+"${skill_args[@]}"} ${budget_args[@]+"${budget_args[@]}"} ${max_turns:+--max-turns "$max_turns"} --model "$model" --effort "$effort" \
      --output-format stream-json --verbose "$@"
  ) <<<"$prompt" >"$output" 2>"$errors" &
  running=$!
  inhibit_sleep "$id" "$running"
  watch_run "$id" "$running" "$stopped" "$output" &
  watcher=$!
  wait "$running"
  code=$?
  # A signal for the loop interrupts wait while the run is still stopping (see the INT/TERM trap).
  while kill -0 "$running" 2>/dev/null; do wait "$running"; code=$?; done
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  end_run "$id"
  # A container whose docker client was killed would go on running.
  if ((${#docker_args[@]})); then "$DOCKER" rm --force "$(container "$id")" >/dev/null 2>&1; fi
  stop_leftovers "$id" "$run"
  running= watcher=
  IFS=$'\t' read -r kind reason <"$stopped"
  claude_stopped= claude_stop_requested=
  case $kind in
    taken) claude_stopped=$reason ;;
    requested) claude_stop_requested=$reason ;;
  esac
  # Even if claude exited cleanly on the TERM, the run didn't finish.
  if [[ -n $kind && $code == 0 ]]; then code=143; fi
  claude_errors=$(<"$errors")
  [[ -n $claude_errors ]] && printf '%s\n' "$claude_errors" >&2
  summary=$(jq -cnR --arg cwd "$PWD" "$RUN_SUMMARY" "$output" 2>/dev/null) || summary='{}'
  # The final message, or what claude printed instead of JSON when it couldn't run (e.g. an error about its options).
  claude_result=$(jq -r 'if .result then .result.result // empty else .output // [] | join("\n") end' <<<"$summary")
  claude_subtype=$(jq -r '.result.subtype // empty' <<<"$summary")
  printf '%s\n' "$claude_result"
  if usage=$(jq -c '.result // empty' <<<"$summary" | jq -ce --arg agent "$worker" \
    --argjson apiKey "$([[ -n $api_key_budget ]] && echo true || echo false)" "$USAGE" 2>/dev/null); then
    response=$(post "/tickets/$id/usage" "$usage")
    [[ ${response##*$'\n'} == 201 ]] || log "can't record the token usage of the run on $id: ${response%$'\n'*}"
  else
    usage=null
  fi
  record_run "$id" "$code" "$summary" "$usage" "$(($(date +%s%3N) - started))"
  rm -f "$output" "$errors" "$stopped"
  if [[ -n $stopping ]]; then exit 0; fi
  return "$code"
}

new_session_id() { { uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid; } | tr 'A-F' 'a-f'; }

# Runs claude on a ticket with the given task (what this run is for: the claim, or the new feedback). On success saves
# the snapshot as the ticket's watermark; on failure keeps the old one and counts the failure for the backoff.
#
# Each run is a claude session whose id is kept in the ticket's state (with the checkout it ran in and the worker that
# ran it), and the next run on the ticket resumes it (claude --resume) with everything the earlier runs already knew
# and did, rather than reading the ticket and exploring the code again:
# - A run that finished keeps its session (`done`), so the run after its plan is approved, and each run for review
#   feedback, carries on the same conversation.
# - A run that didn't end, because the loop or the machine stopped, or that ran out of Claude usage, keeps it too
#   (without `done`), with why it stopped, and the next run picks up where it left off.
# - A run that failed or timed out drops it, so the retry starts a new session, as resuming it would likely fail the
#   same way. So does a run whose ticket was taken away.
# A new session gets the whole prompt: the intro, the board's description, the task and the ticket's checklist steps
# that aren't checked yet (unless the seventh argument is 0). A resumed one already has all that but the task, so it
# gets only the task, after a line saying what it continues (resumed_prompt). If the session can't be resumed (claude
# says "No conversation found", e.g. its history was cleared), the run is started again at once as a new session.
# Either way, the unfinished work in the checkout is put back first (save_work, restore_work).
#
# A run a person stopped (POST /tickets/:id/stop) keeps its session too, with why it stopped, and its work. The ticket
# then waits for feedback that run wasn't handed, such as a comment with new instructions, rather than starting again
# at once: its state's `stopped` holds the stopped run's snapshot, which TRIAGE compares the feedback with. The next
# run resumes the session with that feedback, and drops `stopped`.
run_on_ticket() {
  local id=$1 task=$2 snapshot=$3 fingerprint=$4 ci_runs=${5:-0} branch=${6:-} steps=${7:-1} code limit why state \
    session start prompt notes= work= until
  # Whether this run goes on the API key, Claude usage having run out (see use_api_key), which turns into a pause if
  # the board no longer allows that.
  use_api_key
  # Another loop may have run out of Claude usage since this round started.
  paused && return 0
  state=$(read_state "$id")
  session=$(jq -r '.session.id // ""' <<<"$state")
  claude_stopped= claude_stop_requested= claude_subtype=
  if branch=$(checkout "$branch"); then
    if [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then
      printf '%s %s\n' "$id" "$(git rev-parse HEAD)" >"$(run_file)"
      work=$(restore_work "$id") && log "ticket $id: put back the unfinished work of its previous run ($work)"
    fi
    if [[ -n $work ]]; then
      notes="

The previous run on this ticket didn't finish, and the loop kept its unfinished work: the repository is on $work, \
with that run's uncommitted changes back in the working tree (see git status and git log). Carry on from there. If the \
pull request's branch has moved on origin since, merge it in."
    elif [[ -n $branch && ${AGENT_LOOP_CLEAN:-0} == 1 && -z $(git branch --show-current) ]]; then
      notes="

The repository is checked out at origin/$branch (a detached HEAD, so create your branch from it), freshly updated \
from origin with no local changes."
    elif [[ -n $branch ]]; then
      notes="

The repository is checked out on $branch$(
        [[ ${AGENT_LOOP_CLEAN:-0} == 1 ]] && printf '%s' ", freshly updated from origin with no local changes")."
    fi
    while :; do
      if [[ -n $session ]]; then
        start=--resume
        prompt="$(resumed_prompt "$id" "$state")

$task$notes"
      else
        start=--session-id
        session=$(new_session_id)
        prompt="$(intro)

$task$( ((steps)) && unchecked_steps "$id")$notes"
      fi
      update_state "$id" '.session = ($v | fromjson) | del(.stopped) | .runStart = (now | floor)' \
        "$(jq -nc --arg id "$session" --arg checkout "$PWD" --arg worker "$worker" \
          '{id: $id, checkout: $checkout, worker: $worker}')"
      run_claude "$id" "$prompt" "$start" "$session"
      code=$?
      # When the run started and ended, so that TRIAGE doesn't take the pull request comments it posted (without the
      # marker) for feedback. The last 20 runs are kept.
      update_state "$id" '.runs = ((.runs // []) + [[.runStart // (now | floor), (now | ceil)]])[-20:] | del(.runStart)'
      # The session is gone (e.g. claude's history was cleared, or it was in another checkout claude doesn't look
      # in): run again at once as a new session, with the whole prompt.
      if [[ $code != 0 && $start == --resume && -z $claude_stopped && -z $claude_stop_requested &&
        $claude_errors == *"No conversation found"* ]]; then
        log "can't resume the session of the previous run on $id; starting a new one"
        session=
        continue
      fi
      break
    done
    if [[ $code == 0 && ${AGENT_LOOP_CLEAN:-0} == 1 ]]; then rm -f "$(run_file)"; fi
    checkout "" >/dev/null # back to the default branch between runs, keeping the work of a run that didn't finish
  else
    code=1
    log "can't update the checkout for $id"
  fi
  if [[ $code == 0 ]]; then
    # The snapshot replaces the state, but the session stays for the next run to resume, and the run times stay for
    # TRIAGE.
    write_state "$id" "$(read_state "$id" | jq -c --argjson snapshot "$snapshot" \
      '$snapshot + (. | {runs} | with_entries(select(.value != null))) +
        if .session then {session: (.session | del(.why) + {done: true})} else {} end')"
    remove_scratch "$id"
    return 0
  fi
  if [[ -n $claude_stop_requested ]]; then
    # A person stopped the run, most likely to give the agent new instructions: not a failure, and nothing of the run
    # is lost. Its session stays for the next run to resume, with why it stopped; so does its scratch directory, and
    # with AGENT_LOOP_CLEAN=1 the checkout above kept its work (save_work: the run didn't succeed, so its RUN_FILE is
    # still there) for the next run to put back. That run waits for feedback this one wasn't handed (see `stopped`
    # in TRIAGE), so it doesn't simply pick up what it was stopped from.
    write_state "$id" "$(read_state "$id" | jq -c --argjson snapshot "$snapshot" --arg why "$claude_stop_requested \
stopped it to give you new instructions: read the newest comments on the ticket (and on its pull request, if it has \
one) first, and follow them where they differ from what you were doing" '.session.why = $why
      | .stopped = ($snapshot | {activity, issue, review, inline} | with_entries(select(.value != null)))')"
    log "ticket $id: its run stopped at $claude_stop_requested's request; resuming it once there is new feedback"
    note "$id" "Stopped the agent's run at $claude_stop_requested's request. It resumes, where it left off, once \
there is new feedback, such as a comment."
    return 0
  fi
  if [[ -n $claude_stopped ]]; then
    # Someone took the ticket away from the agent, so this isn't a failure. The next round puts it back in the queue
    # (see requeue) or forgets it.
    update_state "$id" 'del(.session)'
    remove_scratch "$id"
    note "$id" "Stopped the agent's run on this ticket: $claude_stopped."
    return 0
  fi
  log "claude exited with status $code on $id"
  if [[ -z $api_key_budget && $code != 124 ]] && limit=$(grep -iE -m1 "$USAGE_LIMIT_PATTERN" <<<"$claude_result") &&
    [[ -n ${AGENT_API_KEY:-} ]] && get /system/claude-usage | jq -e '.apiKey.usable' >/dev/null 2>&1; then
    # Out of Claude usage, but the board lets runs go on the agents' API key: no pause, and not the ticket's fault.
    # Runs on every ticket go on the key until the limit resets (see use_api_key), starting with this one's next run,
    # which resumes this one where it left off.
    until=$(limit_reset "$limit")
    printf '%s\n' "$until" >"$API_KEY_FILE"
    log "Claude usage limit reached ($limit); runs go on the API key until $(date -d "@$until" '+%F %T')"
    update_state "$id" '.session.why = $v' "it ran out of Claude usage; this run goes on the agents' API key instead"
    note "$id" "Out of Claude usage, so this run stopped. Claude said: \"$limit\". The board lets agents go on on \
their API key, so the next run resumes this one on it, and runs on any ticket go on the key until $(date -d "@$until" \
'+%-I:%M%P %Z on %b %-d') (or until the board's Claude usage shows it is back, if that is sooner). Its cost is billed \
to the key's API credits."
    return 0
  fi
  if [[ -n $api_key_budget && $code != 124 ]] &&
    limit=$(grep -iE -m1 "$API_CREDIT_PATTERN" <<<"$claude_result"$'\n'"$claude_errors"); then
    # The API key is out of credits: wait for the plan's limit to reset, as without the key.
    until=$(cat "$API_KEY_FILE" 2>/dev/null)
    [[ $until =~ ^[0-9]+$ ]] && ((until > $(date +%s))) || until=$(limit_reset "")
    rm -f "$API_KEY_FILE"
    printf '%s\n' "$until" >"$PAUSE_FILE"
    paused_until=$until
    log "the API key is out of credits ($limit); waiting until $(date -d "@$until" '+%F %T') for Claude usage"
    update_state "$id" '.session.why = $v' "the agents' API key ran out of credits"
    note "$id" "The agents' API key is out of API credits, so this run stopped. Claude said: \"$limit\". The loop \
starts no runs on any ticket until $(date -d "@$until" '+%-I:%M%P %Z on %b %-d'), when Claude usage is back (or sooner, \
if the board's Claude usage shows it), then resumes this one where it left off."
    return 0
  fi
  if [[ $code != 124 ]] && limit=$(grep -iE -m1 "$USAGE_LIMIT_PATTERN" <<<"$claude_result"); then
    # Out of Claude usage: not the ticket's fault, so it doesn't count as a failure. Nothing can run until the limit
    # resets, so the whole loop waits for that.
    paused_until=$(limit_reset "$limit")
    printf '%s\n' "$paused_until" >"$PAUSE_FILE"
    log "Claude usage limit reached ($limit); waiting until $(date -d "@$paused_until" '+%F %T')"
    update_state "$id" '.session.why = $v' "it ran out of Claude usage"
    note "$id" "Out of Claude usage, so this run stopped. Claude said: \"$limit\". The loop starts no runs on any \
ticket until $(date -d "@$paused_until" '+%-I:%M%P %Z on %b %-d') (or until the board's Claude usage shows it is back, if \
that is sooner), then resumes this one where it left off."
    return 0
  fi
  if [[ $claude_subtype == error_max_budget_usd ]]; then
    why="it went on the agents' API key and reached its spending cap of \$$api_key_budget (the board's cap per run on the \
key, or what was left of the month's)"
  elif [[ $code == 124 ]]; then
    why="it ran longer than the $TICKET_TIMEOUT timeout (TICKET_TIMEOUT) and was stopped"
  elif [[ $code == 137 ]]; then
    why="claude was killed (SIGKILL), most likely by the kernel for running out of memory: the machine's, or what \
the agents may use together (app-ultrakanban.slice, see docs/agents.md)"
  else
    why="claude exited with status $code"
    [[ -n $claude_result ]] && why+=". Its last output: \"$(tail -n 1 <<<"$claude_result" | cut -c 1-300)\""
  fi
  write_state "$id" "$(read_state "$id" | jq -c --arg fp "$fingerprint" --argjson now "$(date +%s)" \
    --argjson ci "$ci_runs" '. + {failures: (if .failedFor == $fp then (.failures // 0) + 1 else 1 end),
      failedAt: $now, failedFor: $fp, ciRuns: $ci} | del(.session) | if $ci == 0 then del(.capNoted) else . end')"
  remove_scratch "$id"
  note "$id" "Agent run failed: $why. It is retried with backoff, up to $MAX_ATTEMPTS runs in a row; after that, \
new feedback such as a ticket comment retries it."
}

# What a run that resumes the ticket's session (the given state's `session`) is told before its task: what it
# continues, its name if another worker ran the session before (e.g. a cheaper one fixing a merge conflict), and the
# checkout to work in if the session ran in another one. The intro, the board's description and the checklist are
# earlier in the conversation, so they aren't sent again.
resumed_prompt() {
  local id=$1 state=$2 previous was
  previous=$(jq -r '.session.checkout // ""' <<<"$state")
  was=$(jq -r '.session.worker // ""' <<<"$state")
  if [[ $(jq -r '.session.done // false' <<<"$state") == true ]]; then
    printf '%s' "This continues your conversation on ticket $id: your previous run on it finished, and the loop \
started this one for what follows. What you were told earlier in this conversation still holds (the board's \
conventions, the marker line, and your name unless this says otherwise); read the ticket or the pull request again \
only for what you need."
  else
    printf '%s' "This continues your previous run on ticket $id, which stopped before it finished: $(jq -r \
      '.session.why // "the loop running it was stopped, for example by a restart"' <<<"$state"). Carry on from where \
you left off rather than starting over, and check what is already done (on the ticket, the branch and the pull \
request) before doing it again."
  fi
  [[ -z $was || $was == "$worker" ]] || printf '%s' "
Your name for this run (agent field and X-Actor header) is $worker, not $was: the loop runs it with $model at $effort \
effort."
  [[ -z $previous || $previous == "$PWD" ]] || printf '%s' "
Earlier in this conversation you worked in $previous. This run is in $PWD, another checkout of the same repository: \
work only in $PWD from now on, and leave $previous alone, as another run may be using it."
}

intro() {
  printf '%s' "Use the ultrakanban skill. KANBAN=$KANBAN, BOARD=$BOARD.
Your name (agent field and X-Actor header): $worker. Use exactly this name: it says that you are the $AGENT agent
running $model at $effort effort.
This is a non-interactive run started by scripts/agent-loop.sh: do the work, then exit. Don't wait for review; the loop
starts a new run when feedback arrives. If you need an answer from a human, ask in a ticket comment and exit.
People often comment while you work, and this prompt only has what was there when the run started. Just before you
submit the ticket for review or post your closing comment, read its activity again (and the pull request's comments, if
it has one), and handle anything new first.
If the ticket's description has a checklist (- [ ] step), check off each step as soon as you finish it with
POST $KANBAN/api/tickets/<id>/checklist/<index> (0-based) instead of editing the description. Do it right then, not all
at once before submitting: people follow the ticket's progress by it. Check off only what you did; leave a step you
skipped or that doesn't apply unchecked and say why in your review comment.
End every pull request comment, review and inline reply you post with this exact line, so the loop doesn't mistake
your own replies for feedback:
$MARKER"
  # The board's description holds conventions for every ticket on it, so each run gets it rather than having to look.
  local description
  description=$(board | jq -r '.board.description // "" | gsub("^\\s+|\\s+$"; "")') || description=
  [[ -z $description ]] || printf '%s' "

The board's description (its conventions for every ticket on it; follow them unless the ticket says otherwise):

$description"
}

# The ticket's checklist steps that aren't checked yet, with their indexes, for its prompt; nothing when there are none.
unchecked_steps() {
  local steps
  steps=$(get "/tickets/$1/checklist" | jq -r 'map(select(.checked | not) | "\(.index): \(.text)") | join("\n")') ||
    return 0
  [[ -z $steps ]] || printf '%s' "

The ticket's checklist steps that aren't checked yet (index: step). Make them your task list, and check each one off on
the board as soon as it's done:
$steps"
}
