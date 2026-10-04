#!/usr/bin/env bash
# Keeps one agent loop running for every board whose agent is switched on (board settings in the app), and stops
# the loops of boards that are switched off or deleted. Runs on the host as the ultrakanban-agent systemd user
# service, because the agents need your claude login, gh auth and git.
#
# Each loop is its own systemd user unit, ultrakanban-agent@<board>, running agent-board.sh. systemd restarts a loop
# that dies (with backoff), gives each one its own log in the journal, and stopping a unit kills everything it
# started, so no processes are left behind. This script only decides which units should run.
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
# Settings: KANBAN (default http://localhost:4317), POLL_SECONDS (default 30), UPDATE_FETCH_SECONDS (default 900) and
# ULTRAKANBAN_AGENT_HOME.

set -uo pipefail

KANBAN=${KANBAN:-http://localhost:4317}
POLL_SECONDS=${POLL_SECONDS:-30}
UPDATE_FETCH_SECONDS=${UPDATE_FETCH_SECONDS:-900}
AGENT_HOME=${ULTRAKANBAN_AGENT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ultrakanban-agent}
self=$(readlink -f "$0")
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
      systemctl --user restart "$unit"
      continue
    fi
    state=$(systemctl --user is-active "$unit")
    case $state in
      active | activating | reloading | deactivating) ;;
      *)
        echo "board $id: agent loop is $state; starting it"
        systemctl --user reset-failed "$unit" 2>/dev/null
        systemctl --user start "$unit"
        ;;
    esac
  done <<<"$wanted"

  units=$(systemctl --user list-units --all --plain --no-legend 'ultrakanban-agent@*.service' | awk '{print $1}')
  for unit in $units; do
    id=${unit#ultrakanban-agent@}
    id=${id%.service}
    [[ $'\n'$wanted == *$'\n'"$id"$'\t'* ]] && continue
    state=$(systemctl --user is-active "$unit")
    [[ $state == inactive ]] && continue
    echo "board $id: agent switched off or board deleted; stopping its loop"
    systemctl --user stop "$unit"
    systemctl --user reset-failed "$unit" 2>/dev/null
    rm -f "$AGENT_HOME/boards/$id/settings"
  done
}

trap 'kill $! 2>/dev/null; exit 0' INT TERM

echo "watching $KANBAN for boards with the agent switched on"
while true; do
  check_in
  update_scripts
  reconcile
  sleep "$POLL_SECONDS" &
  wait $!
done
