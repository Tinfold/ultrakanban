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
# Settings: KANBAN (default http://localhost:4317), POLL_SECONDS (default 30) and ULTRAKANBAN_AGENT_HOME.

set -uo pipefail

KANBAN=${KANBAN:-http://localhost:4317}
POLL_SECONDS=${POLL_SECONDS:-30}
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

reconcile() {
  local boards wanted id repo agent model effort concurrency settings unit state units
  boards=$(curl -sf "$KANBAN/api/boards") || { echo "can't reach $KANBAN; leaving the loops as they are"; return; }
  wanted=$(jq -r '.[] | select(.agentEnabled and .githubRepo != null)
    | [.id, .githubRepo, .agentName // "claude", .agentModel // "opus", .agentEffort // "high", .agentConcurrency // 1]
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
  update_scripts
  reconcile
  sleep "$POLL_SECONDS" &
  wait $!
done
