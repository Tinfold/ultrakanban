#!/usr/bin/env bash
# Keeps one agent loop running for every board whose agent is switched on (board settings in the app), and stops
# the loops of boards that are switched off or deleted. Runs on the host as the ultrakanban-agent systemd user
# service, because the agents need your claude login, gh auth and git.
#
# Each loop is its own systemd user unit, ultrakanban-agent@<board>, running agent-board.sh. systemd restarts a loop
# that dies (with backoff), gives each one its own log in the journal, and stopping a unit kills everything it
# started, so no processes are left behind. This script only decides which units should run.
#
# Where there are no systemd user services (the agents container, macOS), or with NO_SYSTEMD=1, it runs the loops itself
# as its child processes instead: it restarts one that dies (waiting 30 s, doubling up to 15 min) and stops them all
# when it stops. Their logs go to its own output, each line marked with the board.
#
# It also keeps the installed scripts and skill up to date. install-services.sh notes the checkout it installed them
# from and that checkout's default branch commit, in AGENT_HOME/installed-from. When that branch moves (you pull),
# this script copies the branch's versions over the installed ones: each agent loop starts again with them before its
# next run (see agent-board.sh), and this script restarts itself. Other branches checked out there change nothing.
#
# And it updates ultrakanban itself when someone asks for it in the app (the update button in the header): it pulls
# that checkout's default branch, rebuilds and restarts the board (ultrakanban.service's compose project), and reports
# how it went. Every poll it checks in with the checkout's version and how many commits it is behind origin (fetched
# every UPDATE_FETCH_SECONDS), which the app shows next to the button.
#
# And every CLAUDE_USAGE_SECONDS it reads how much of the Claude plan's usage limits is used, with your claude login (as
# /usage in claude does), and reports it to the board for the overview. The board can't: it runs in a container.
#
# Settings: KANBAN (default http://localhost:4317), POLL_SECONDS (default 30), UPDATE_FETCH_SECONDS (default 900),
# CLAUDE_USAGE_SECONDS (default 300), NO_SYSTEMD and ULTRAKANBAN_AGENT_HOME.

set -uo pipefail

KANBAN=${KANBAN:-http://localhost:4317}
POLL_SECONDS=${POLL_SECONDS:-30}
UPDATE_FETCH_SECONDS=${UPDATE_FETCH_SECONDS:-900}
CLAUDE_USAGE_SECONDS=${CLAUDE_USAGE_SECONDS:-300}
AGENT_HOME=${ULTRAKANBAN_AGENT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ultrakanban-agent}
self=$(readlink -f "$0")
systemd=1
[[ -z ${NO_SYSTEMD:-} ]] && systemctl --user show-environment >/dev/null 2>&1 || systemd=
# The installed files and where they come from in the checkout.
INSTALLED=(bin/agent-loop.sh:scripts/agent-loop.sh bin/agent-board.sh:scripts/agent-board.sh
  bin/agent-supervisor.sh:scripts/agent-supervisor.sh skill/SKILL.md:.claude/skills/ultrakanban/SKILL.md)
for part in triage board ci checkout run tickets; do
  INSTALLED+=("bin/agent-loop/$part.sh:scripts/agent-loop/$part.sh")
done

# Copies the installed files from the checkout's default branch when it has moved since they were installed.
update_scripts() {
  local checkout installed branch commit entry target tmp updated= missing=
  { read -r checkout && read -r installed; } 2>/dev/null <"$AGENT_HOME/installed-from" || return 0
  branch=$(git -C "$checkout" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || branch=origin/main
  branch=${branch#origin/}
  commit=$(git -C "$checkout" rev-parse --verify --quiet "$branch^{commit}" 2>/dev/null) || return 0
  # A file that isn't installed yet is copied even when the commit is the same: an older version of this script may
  # have installed that commit without it.
  if [[ $commit == "$installed" ]]; then
    for entry in "${INSTALLED[@]}"; do
      [[ -f $AGENT_HOME/${entry%%:*} ]] || missing=1
    done
    [[ -n $missing ]] || return 0
  fi

  for entry in "${INSTALLED[@]}"; do
    target=$AGENT_HOME/${entry%%:*}
    mkdir -p "${target%/*}" && tmp=$(mktemp "$target.XXXXXX") || continue
    # Replaced with a rename, never overwritten: a running bash script reads its file as it goes.
    if git -C "$checkout" show "$commit:${entry#*:}" >"$tmp" 2>/dev/null && ! cmp -s "$tmp" "$target" &&
      chmod "$([[ $target == *.sh ]] && echo 755 || echo 644)" "$tmp" && mv -f "$tmp" "$target"; then
      updated+=" ${entry%%:*}"
    else
      rm -f "$tmp"
    fi
  done
  printf '%s\n%s\n' "$checkout" "$commit" >"$AGENT_HOME/installed-from"
  [[ -n $updated ]] || return 0
  echo "updated$updated to $branch at ${commit:0:7} in $checkout"
  if [[ $updated == *agent-supervisor.sh* ]]; then
    echo "restarting with the new agent-supervisor.sh"
    exec "$self"
  fi
}

# Posts to the board's update status (see reportAppUpdateSchema): `report <json>`. Prints the status it answers with.
report() {
  curl -sf -X POST "$KANBAN/api/system/update/status" -H 'Content-Type: application/json' \
    -H 'X-Actor: agent-supervisor' -d "$1"
}

# The checkout's version and how far its default branch is behind origin, as report fields.
checkout_state() {
  local checkout=$1 branch=$2 behind
  behind=$(git -C "$checkout" rev-list --count "$branch..origin/$branch" 2>/dev/null) || behind=null
  jq -nc --arg version "$(git -C "$checkout" log -1 --format='%h %s' 2>/dev/null)" --argjson behind "$behind" \
    '{version: (if $version == "" then null else $version end), behind: $behind}'
}

last_fetch=
interrupted=1
# Checks in with the board, and updates it when someone has asked for that.
check_in() {
  local checkout branch fields status
  { read -r checkout; } 2>/dev/null <"$AGENT_HOME/installed-from" || return 0
  branch=$(git -C "$checkout" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || branch=origin/main
  branch=${branch#origin/}
  if [[ -z $last_fetch ]] || ((SECONDS - last_fetch >= UPDATE_FETCH_SECONDS)); then
    GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$checkout" fetch --quiet origin "$branch" 2>/dev/null
    last_fetch=$SECONDS
  fi
  fields=$(checkout_state "$checkout" "$branch")
  status=$(report "$fields") || return 0
  # An update this script was doing when it stopped (it doesn't restart itself until it has reported on one).
  if [[ -n $interrupted && $(jq -r .state <<<"$status") == running ]]; then
    report '{"state":"failed","message":"The agent supervisor stopped during the update. Ask for it again."}' >/dev/null
  fi
  interrupted=
  [[ $(jq -r .state <<<"$status") == requested ]] && update_board "$checkout" "$branch"
}

# Pulls the checkout's default branch, then rebuilds and restarts the board on it.
update_board() {
  local checkout=$1 branch=$2 current output compose waited=0
  update_failed() {
    echo "update failed: $1"
    report "$(jq -nc --arg message "$1" --argjson fields "$(checkout_state "$checkout" "$branch")" \
      '$fields + {state: "failed", message: $message}')" >/dev/null
  }
  # Taking the request fails when it was withdrawn meanwhile.
  report "$(jq -nc --arg message "Pulling $branch in $checkout" '{state: "running", message: $message}')" \
    >/dev/null || return 0
  echo "updating ultrakanban: pulling $branch in $checkout"

  current=$(git -C "$checkout" symbolic-ref --quiet --short HEAD 2>/dev/null)
  if [[ $current != "$branch" ]]; then
    update_failed "$checkout has ${current:-a detached HEAD} checked out, not $branch. Switch it back to $branch to update."
    return
  fi
  if [[ -n $(git -C "$checkout" status --porcelain --untracked-files=no) ]]; then
    update_failed "$checkout has local changes. Commit or stash them to update."
    return
  fi
  if ! output=$(GIT_TERMINAL_PROMPT=0 timeout 300 git -C "$checkout" pull --ff-only --quiet origin "$branch" 2>&1); then
    update_failed "git pull failed: $(tail -c 1500 <<<"$output")"
    return
  fi
  last_fetch=$SECONDS

  if ! systemctl --user cat ultrakanban.service >/dev/null 2>&1; then
    update_failed "Pulled $(git -C "$checkout" log -1 --format='%h %s'), but the board doesn't run as ultrakanban.service \
(scripts/install-services.sh), so restart it yourself."
    return
  fi
  if command -v podman-compose >/dev/null; then
    compose=(podman-compose)
  elif docker compose version >/dev/null 2>&1; then
    compose=(docker compose)
  else
    update_failed "Pulled, but found neither podman-compose nor docker compose to rebuild the board with."
    return
  fi
  echo "rebuilding and restarting the board"
  if ! output=$("${compose[@]}" -f "$checkout/docker-compose.yml" up -d --build 2>&1); then
    update_failed "Rebuilding the board failed: $(tail -c 1500 <<<"$output")"
    return
  fi
  # The app restarts with the new build; wait for it to answer again, so the report gets through.
  until curl -sf "$KANBAN/api/system/update" >/dev/null || ((waited >= 300)); do
    sleep 5
    ((waited += 5))
  done
  echo "updated ultrakanban to $(git -C "$checkout" log -1 --format='%h %s')"
  report "$(jq -nc --arg message "Updated to $(git -C "$checkout" log -1 --format='%h %s')" \
    --argjson fields "$(checkout_state "$checkout" "$branch")" '$fields + {state: "done", message: $message}')" \
    >/dev/null || echo "couldn't report the update to $KANBAN"
}

last_usage=
# Reports how much Claude usage is left to the board (see reportClaudeUsageSchema), every CLAUDE_USAGE_SECONDS.
report_claude_usage() {
  local credentials token plan usage body
  [[ -z $last_usage ]] || ((SECONDS - last_usage >= CLAUDE_USAGE_SECONDS)) || return 0
  last_usage=$SECONDS
  credentials=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json
  token=$(jq -r '.claudeAiOauth.accessToken // empty' "$credentials" 2>/dev/null)
  plan=$(jq -r '.claudeAiOauth.subscriptionType // empty' "$credentials" 2>/dev/null)
  # A token from `claude setup-token`, which the agents container can be given instead of a login.
  [[ -n $token ]] || token=${CLAUDE_CODE_OAUTH_TOKEN:-}
  if [[ -z $token ]]; then
    body=$(jq -nc --arg error "No claude login found in $credentials. Log in on the Setup page, or run claude auth login where the agents run." \
      '{error: $error}')
  # The token goes to curl on stdin, not on its command line, where other users could read it.
  elif usage=$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sf --max-time 30 -K - -H 'anthropic-beta: oauth-2025-04-20' https://api.anthropic.com/api/oauth/usage) &&
    jq -e 'type == "object"' >/dev/null 2>&1 <<<"$usage"; then
    body=$(jq -nc --arg plan "$plan" --argjson usage "$usage" '{plan: ($plan | select(. != "")), usage: $usage}')
  else
    # Claude refreshes an expired login the next time it runs.
    body=$(jq -nc --arg plan "$plan" '{plan: ($plan | select(. != "")),
      error: "Claude didn\u0027t answer with the usage; the claude login may have expired. Running claude refreshes it."}')
  fi
  curl -sf -X POST "$KANBAN/api/system/claude-usage" -H 'Content-Type: application/json' \
    -H 'X-Actor: agent-supervisor' -d "$body" >/dev/null || echo "couldn't report Claude usage to $KANBAN"
}

runs_in=machine
[[ -z ${ULTRAKANBAN_AGENTS_CONTAINER:-} ]] || runs_in=container
last_agents=
agents_fields=
login_pid=
# Checks in with where the agents run and which logins they have, for the board's Setup page (see
# reportAgentHostSchema), and starts a login the page asked for. The logins are looked at every CLAUDE_USAGE_SECONDS,
# and after a login.
report_agents() {
  local github claude name email identity= state
  if [[ -z $last_agents ]] || ((SECONDS - last_agents >= CLAUDE_USAGE_SECONDS)); then
    last_agents=$SECONDS
    github=$(timeout 20 gh api user --jq .login 2>/dev/null)
    if [[ -n ${CLAUDE_CODE_OAUTH_TOKEN:-} ]]; then
      claude=token
    elif ! claude=$(timeout 30 claude auth status --json 2>/dev/null | jq -er 'if .loggedIn then .email // "logged in" else "" end' 2>/dev/null); then
      # A claude without `auth status`: its login file is all there is to go by.
      claude=
      [[ -f ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json ]] && claude='logged in'
    fi
    name=$(git config --global user.name)
    email=$(git config --global user.email)
    [[ -n $name && -n $email ]] && identity="$name <$email>"
    # `if` needs its `else`: jq 1.6 (the agents container's, Debian's and Ubuntu 22.04's) doesn't compile one without.
    agents_fields=$(jq -nc --arg runsIn "$runs_in" --arg github "$github" --arg claude "$claude" --arg git "$identity" '
      def orNull: if . == "" then null else . end;
      {runsIn: $runsIn, githubLogin: ($github | orNull), claudeAccount: ($claude | orNull), gitIdentity: ($git | orNull)}')
  fi
  state=$(curl -sf -X POST "$KANBAN/api/system/agents" -H 'Content-Type: application/json' \
    -H 'X-Actor: agent-supervisor' -d "$agents_fields" | jq -r '.login.state // empty' 2>/dev/null) ||
    echo "couldn't check in with $KANBAN for its Setup page"
  [[ $state == requested ]] && start_login
}

# Starts the login asked for, unless one is running already. It runs in the background, so the loops are looked after
# meanwhile.
start_login() {
  local login
  [[ -n $login_pid ]] && kill -0 "$login_pid" 2>/dev/null && return 0
  login=$(curl -sf "$KANBAN/api/system/agents/login") || return 0
  [[ $(jq -r '.state // empty' <<<"$login") == requested ]] || return 0
  run_login "$(jq -r .kind <<<"$login")" "$(jq -r .requestedAt <<<"$login")" &
  login_pid=$!
}

# Posts to the login's status (see reportAgentLoginSchema): `login_report <json>`. Fails when the login is over or was
# cancelled.
login_report() {
  curl -sf -X POST "$KANBAN/api/system/agents/login/status" -H 'Content-Type: application/json' \
    -H 'X-Actor: agent-supervisor' -d "$1"
}

# Runs `gh auth login` or `claude auth login` (`run_login <github|claude> <requestedAt>`) where the agents run, for the
# login asked for on the Setup page: it reports GitHub's one-time code or Claude's sign-in link for the page to show,
# gives claude the code pasted back on the page, and reports how it went. Stops when the login is cancelled or after
# 15 minutes, when the code or link has expired.
run_login() {
  local kind=$1 requested=$2 dir pid fd url user_code code login message= status deadline=$((SECONDS + 900)) shown= over=
  echo "logging the agents in to $kind, as asked on the Setup page"
  if [[ $kind == github ]] && ! command -v gh >/dev/null; then
    message="gh isn't installed where the agents run. Install the GitHub CLI (https://github.com/cli/cli/blob/trunk/docs/install_linux.md), then log in again."
  elif [[ $kind == claude ]] && ! command -v claude >/dev/null; then
    message="Claude Code isn't installed where the agents run. Install it (npm install -g @anthropic-ai/claude-code), then log in again."
  fi
  if [[ -n $message ]]; then
    echo "the $kind login failed: $message"
    login_report "$(jq -nc --arg message "$message" '{state: "failed", message: $message}')" >/dev/null
    return
  fi
  dir=$(mktemp -d) && mkfifo "$dir/in" || {
    login_report '{"state":"failed","message":"Could not start the login."}' >/dev/null
    return
  }
  # gh uses GH_TOKEN instead of a login when it is set, and won't log in.
  if [[ $kind == github ]]; then
    GH_TOKEN='' GITHUB_TOKEN='' gh auth login --hostname github.com --git-protocol https --web --scopes workflow \
      <"$dir/in" >"$dir/out" 2>&1 &
  else
    # BROWSER: there's no browser to open where the agents run; the page shows the link.
    BROWSER=true claude auth login <"$dir/in" >"$dir/out" 2>&1 &
  fi
  pid=$!
  exec {fd}>"$dir/in" # its input stays open until the code is written to it

  while kill -0 "$pid" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      kill "$pid" 2>/dev/null
      login_report '{"state":"failed","message":"The login timed out after 15 minutes. Start it again."}' >/dev/null
      over=1
      break
    fi
    login=$(curl -sf "$KANBAN/api/system/agents/login")
    if [[ -n $login && ($(jq -r '.requestedAt // empty' <<<"$login") != "$requested" ||
      $(jq -r '.state // empty' <<<"$login") == @(done|failed)) ]]; then
      echo "the $kind login was cancelled"
      kill "$pid" 2>/dev/null
      over=1
      break
    fi
    if [[ -z $shown ]]; then
      if [[ $kind == github ]]; then
        user_code=$(sed -n 's/.*one-time code: *\([A-Z0-9-]*\).*/\1/p' "$dir/out" | head -n 1)
        url=$(grep -o 'https://github.com/login/device' "$dir/out" | head -n 1)
        [[ -n $user_code ]] || url=
      else
        url=$(grep -o 'https://[^ ]*oauth/authorize[^ ]*' "$dir/out" | head -n 1)
      fi
      if [[ -n $url ]]; then
        login_report "$(jq -nc --arg url "$url" --arg code "${user_code:-}" \
          '{state: "waiting", url: $url, userCode: (if $code == "" then null else $code end)}')" >/dev/null || {
          kill "$pid" 2>/dev/null
          over=1
          break
        }
        shown=1
      fi
    elif [[ $kind == claude ]] && code=$(jq -r '.code // empty' <<<"$login") && [[ -n $code ]]; then
      login_report '{"state":"checking"}' >/dev/null && printf '%s\n' "$code" >&"$fd"
    fi
    sleep 2
  done
  wait "$pid"
  status=$?
  exec {fd}>&-
  if [[ -n $over ]]; then
    rm -rf "$dir"
    return
  fi
  # Its last line says why it failed (after claude's prompt for the code, on the same line).
  message=$(sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$dir/out" | grep -v '^[[:space:]]*$' | tail -n 1 | sed 's/^.*if prompted > //')
  rm -rf "$dir"
  if ((status != 0)); then
    echo "the $kind login failed: $message"
    login_report "$(jq -nc --arg message "${message:-It stopped without saying why.}" \
      '{state: "failed", message: $message}')" >/dev/null
    return
  fi

  if [[ $kind == github ]]; then
    login=$(gh api user --jq .login 2>/dev/null)
    after_github_login
    message="Logged in to GitHub as ${login:-?}."
  else
    login=$(claude auth status --json 2>/dev/null | jq -r '.email // empty' 2>/dev/null)
    message="Logged in to Claude${login:+ as $login}."
  fi
  echo "$message"
  login_report "$(jq -nc --arg message "$message" '{state: "done", message: $message}')" >/dev/null
}

# After logging in to GitHub: git pushes with gh's login and commits as that GitHub user (unless git has a name and
# email already), and the board follows pull requests with the token if it has none.
after_github_login() {
  gh auth setup-git
  if [[ -z $(git config --global user.email) ]]; then
    git config --global user.name "$(gh api user --jq '.name // .login')"
    git config --global user.email "$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
  fi
  if [[ $(curl -sf "$KANBAN/api/system/setup" | jq -r '.github.auth // empty') == "" ]]; then
    # The token goes to curl on stdin, not on its command line.
    gh auth token | jq -Rc '{token: .}' | curl -sf -X PUT "$KANBAN/api/system/github-token" \
      -H 'Content-Type: application/json' -H 'X-Actor: agent-supervisor' -d @- >/dev/null &&
      echo "gave the board the GitHub token"
  fi
}

# Waits POLL_SECONDS, but starts a login asked for on the Setup page within a few seconds, and checks in again as soon
# as one finishes.
wait_poll() {
  local waited=0
  while ((waited < POLL_SECONDS)); do
    sleep 3 &
    wait $!
    ((waited += 3))
    if [[ -n $login_pid ]]; then
      kill -0 "$login_pid" 2>/dev/null && continue
      wait "$login_pid" 2>/dev/null
      login_pid=
      last_agents=
      report_agents
    elif [[ $(curl -sf "$KANBAN/api/system/agents/login" | jq -r '.state // empty' 2>/dev/null) == requested ]]; then
      start_login
    fi
  done
}

reconcile() {
  local boards wanted id repo agent model effort concurrency settings unit state units
  boards=$(curl -sf "$KANBAN/api/boards") || { echo "can't reach $KANBAN; leaving the loops as they are"; return; }
  wanted=$(jq -r '.[] | select(.agentEnabled and .githubRepo != null)
    | [.id, .githubRepo, .agentName // "claude", .agentModel // "opus", .agentEffort // "medium", .agentConcurrency // 1]
    | @tsv' <<<"$boards")

  while IFS=$'\t' read -r id repo agent model effort concurrency; do
    [[ -n $id ]] || continue
    unit="ultrakanban-agent@$id.service"
    settings="$repo $agent/$model/$effort x$concurrency"
    if [[ $(cat "$AGENT_HOME/boards/$id/settings" 2>/dev/null) != "$settings" ]]; then
      echo "board $id: starting its agent loop ($repo as $agent/$model/$effort, $concurrency at a time)"
      mkdir -p "$AGENT_HOME/boards/$id" && printf '%s\n' "$settings" >"$AGENT_HOME/boards/$id/settings"
      loop_restart "$id"
      continue
    fi
    loop_state "$id"
    case $state in
      active | activating | reloading | deactivating) ;;
      *)
        if ((SECONDS < ${not_before[$id]:-0})); then
          echo "board $id: agent loop stopped; starting it again in $((not_before[$id] - SECONDS)) s"
        else
          echo "board $id: agent loop is $state; starting it"
        fi
        loop_start "$id"
        ;;
    esac
  done <<<"$wanted"

  for id in $(loop_list); do
    [[ $'\n'$wanted == *$'\n'"$id"$'\t'* ]] && continue
    loop_state "$id"
    [[ $state == inactive ]] && continue
    echo "board $id: agent switched off or board deleted; stopping its loop"
    loop_stop "$id"
    rm -f "$AGENT_HOME/boards/$id/settings"
  done
}

# The loops: systemd units, or this script's child processes without systemd (see the top).
declare -A pids=() failures=() started=() not_before=()
loop_list() {
  if [[ -n $systemd ]]; then
    systemctl --user list-units --all --plain --no-legend 'ultrakanban-agent@*.service' |
      awk '{sub(/^ultrakanban-agent@/, "", $1); sub(/\.service$/, "", $1); print $1}'
  else
    printf '%s\n' "${!pids[@]}"
  fi
}
# Sets state to the board's loop's state, as systemctl is-active says it.
loop_state() {
  local failed
  if [[ -n $systemd ]]; then
    state=$(systemctl --user is-active "ultrakanban-agent@$1.service")
  elif [[ -n ${pids[$1]:-} ]] && kill -0 "${pids[$1]}" 2>/dev/null; then
    state=active
  elif [[ -n ${pids[$1]:-} ]]; then
    # It stopped by itself: start it again after a wait that grows with each quick failure, as systemd does.
    ((SECONDS - started[$1] < 900)) || failures[$1]=0
    failed=${failures[$1]:-0}
    not_before[$1]=$((SECONDS + (failed < 5 ? 30 << failed : 900)))
    failures[$1]=$((failed + 1))
    unset 'pids[$1]'
    state=failed
  elif ((SECONDS < ${not_before[$1]:-0})); then
    state=activating # waiting to be started again
  else
    state=inactive
  fi
}
loop_start() {
  if [[ -n $systemd ]]; then
    systemctl --user reset-failed "ultrakanban-agent@$1.service" 2>/dev/null
    systemctl --user start "ultrakanban-agent@$1.service"
    return
  fi
  ((SECONDS >= ${not_before[$1]:-0})) || return 0
  "${self%/*}/agent-board.sh" "$1" > >(while IFS= read -r line; do printf 'board %s: %s\n' "$1" "$line"; done) 2>&1 &
  pids[$1]=$!
  started[$1]=$SECONDS
}
loop_stop() {
  local waited=0
  if [[ -n $systemd ]]; then
    systemctl --user stop "ultrakanban-agent@$1.service"
    systemctl --user reset-failed "ultrakanban-agent@$1.service" 2>/dev/null
    return
  fi
  if [[ -n ${pids[$1]:-} ]]; then
    kill "${pids[$1]}" 2>/dev/null
    while kill -0 "${pids[$1]}" 2>/dev/null && ((waited++ < 30)); do sleep 1; done
    kill -KILL "${pids[$1]}" 2>/dev/null
  fi
  unset 'pids[$1]' 'failures[$1]' 'not_before[$1]'
}
loop_restart() {
  if [[ -n $systemd ]]; then
    systemctl --user restart "ultrakanban-agent@$1.service"
  else
    loop_stop "$1"
    loop_start "$1"
  fi
}
stop_all() {
  local id
  [[ -n $systemd ]] && return
  for id in "${!pids[@]}"; do loop_stop "$id"; done
}

trap 'kill $! ${login_pid:-} 2>/dev/null; stop_all; exit 0' INT TERM

echo "watching $KANBAN for boards with the agent switched on${systemd:+ (loops run as systemd user units)}"
while true; do
  check_in
  report_claude_usage
  report_agents
  update_scripts
  reconcile
  wait_poll
done
