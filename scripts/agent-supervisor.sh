#!/usr/bin/env bash
# Keeps one agent loop running for every board whose agent is switched on (board settings in the app), and stops
# the loops of boards that are switched off or deleted. Runs on the host as the ultrakanban-agent systemd user
# service, because the agents need your claude login, gh auth and git.
#
# Each loop is its own systemd user unit, ultrakanban-agent@<board>, running agent-board.sh. systemd restarts a loop
# that dies (with backoff), gives each one its own log in the journal, and stopping a unit kills everything it
# started, so no processes are left behind. This script only decides which units should run.
#
# Settings: KANBAN (default http://localhost:4317), POLL_SECONDS (default 30) and ULTRAKANBAN_AGENT_HOME.

set -uo pipefail

KANBAN=${KANBAN:-http://localhost:4317}
POLL_SECONDS=${POLL_SECONDS:-30}
AGENT_HOME=${ULTRAKANBAN_AGENT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ultrakanban-agent}

reconcile() {
  local boards wanted id repo agent model effort settings unit state units
  boards=$(curl -sf "$KANBAN/api/boards") || { echo "can't reach $KANBAN; leaving the loops as they are"; return; }
  wanted=$(jq -r '.[] | select(.agentEnabled and .githubRepo != null)
    | [.id, .githubRepo, .agentName // "claude", .agentModel // "opus", .agentEffort // "high"] | @tsv' <<<"$boards")

  while IFS=$'\t' read -r id repo agent model effort; do
    [[ -n $id ]] || continue
    unit="ultrakanban-agent@$id.service"
    settings="$repo $agent/$model/$effort"
    if [[ $(cat "$AGENT_HOME/boards/$id/settings" 2>/dev/null) != "$settings" ]]; then
      echo "board $id: starting its agent loop ($repo as $agent/$model/$effort)"
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
  reconcile
  sleep "$POLL_SECONDS" &
  wait $!
done
