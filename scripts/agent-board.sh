#!/usr/bin/env bash
# Runs agent-loop.sh for one board, in that board's own clone of its GitHub repository (never a working copy of
# yours). Started by the ultrakanban-agent@<board> systemd user unit, which agent-supervisor.sh manages.
#
# The board's agentConcurrency (1 when not set) is how many tickets it works at once: that many loops, the first in the
# clone and each other one in its own git worktree of it (worktrees/<n>), sharing one state directory. If one loop
# stops, the others are stopped too and the script exits, so systemd restarts them all. The board's
# agentConflictConcurrency (2 when not set) is how many more loops it runs, each in a worktree of its own too, that only
# fix merge conflicts (CONFLICTS_ONLY, see agent-loop.sh), so the conflicts that merging one pull request causes in the
# others are fixed side by side even when the board works one ticket at a time. When the installed scripts or
# skill change, each loop stops before its next run and is started again with the new ones on its own. Only a change
# to this script or its systemd unit waits for them all to stop, and then starts it (or the unit) again.
#
#   agent-board.sh <board id>
#
# Settings: KANBAN (default http://localhost:4317), IDLE_SECONDS (default 60, see agent-loop.sh) and
# ULTRAKANBAN_AGENT_HOME (default $XDG_DATA_HOME/ultrakanban-agent). The board's clone, worktrees and loop state live in
# $ULTRAKANBAN_AGENT_HOME/boards/<board>.

set -uo pipefail

BOARD=${1:?usage: agent-board.sh <board id>}
KANBAN=${KANBAN:-http://localhost:4317}
AGENT_HOME=${ULTRAKANBAN_AGENT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ultrakanban-agent}
here=$(dirname "$(readlink -f "$0")")
dir=$AGENT_HOME/boards/$BOARD

board=$(curl -sf "$KANBAN/api/boards/$BOARD") || { echo "can't read board $BOARD from $KANBAN"; exit 1; }
repo=$(jq -r '.board.githubRepo // ""' <<<"$board")
agent=$(jq -r '.board.agentName // "claude"' <<<"$board")
model=$(jq -r '.board.agentModel // "opus"' <<<"$board")
effort=$(jq -r '.board.agentEffort // "medium"' <<<"$board")
concurrency=$(jq -r '.board.agentConcurrency // 1' <<<"$board")
[[ $concurrency =~ ^[1-9][0-9]*$ ]] || concurrency=1
conflicts=$(jq -r '.board.agentConflictConcurrency // 2' <<<"$board")
[[ $conflicts =~ ^[0-9]+$ ]] || conflicts=2
loops=$((concurrency + conflicts))
if [[ $(jq -r .board.agentEnabled <<<"$board") != true || -z $repo ]]; then
  echo "the agent is off for board $BOARD"
  exit 0
fi

# Under systemd, the unit this runs as and its unit file. A unit keeps the settings (and slice) its file had when it
# started; agent-supervisor.sh updates the file. When the file is newer than the unit, this restarts the unit, which
# only happens here, before any loop has started a run.
unit=ultrakanban-agent@$BOARD.service unit_file=
if [[ $(systemctl --user show -p MainPID --value "$unit" 2>/dev/null) == "$$" ]]; then
  unit_file=$(systemctl --user show -p FragmentPath --value "$unit")
fi
unit_outdated() {
  local started
  [[ -n $unit_file ]] || return 1
  started=$(systemctl --user show --timestamp=unix -p ActiveEnterTimestamp --value "$unit" 2>/dev/null)
  [[ $started == @* ]] && (($(stat -c %Y "$unit_file" 2>/dev/null || echo 0) > ${started#@}))
}
if unit_outdated; then
  echo "its systemd unit was updated; restarting it with the new one"
  # The supervisor reloads systemd right after copying the file: a restart before that would keep the old settings.
  for _ in {1..10}; do
    [[ $(systemctl --user show -p NeedDaemonReload --value "$unit") == yes ]] || break
    sleep 1
  done
  # Not waited for: stopping the unit stops this script.
  systemctl --user restart --no-block "$unit" && sleep 60
fi

mkdir -p "$dir" || exit 1
if [[ $(git -C "$dir/repo" config --get ultrakanban.repo 2>/dev/null) != "$repo" ]]; then
  echo "cloning $repo into $dir/repo"
  rm -rf "$dir/repo" "$dir/worktrees"
  gh repo clone "$repo" "$dir/repo" -- --quiet || { echo "can't clone $repo"; exit 1; }
  git -C "$dir/repo" config ultrakanban.repo "$repo"
fi

# One checkout per loop: the clone, then worktrees/2 up to worktrees/<concurrency>, then one per conflict loop. Worktrees
# beyond that go, after keeping the work of a run that was stopped in them, which the ticket's next run gets back.
checkouts=("$dir/repo")
git -C "$dir/repo" worktree prune
for ((n = 2; n <= loops; n++)); do
  if [[ ! -e $dir/worktrees/$n/.git ]]; then
    rm -rf "$dir/worktrees/$n"
    git -C "$dir/repo" worktree add --quiet --detach "$dir/worktrees/$n" ||
      { echo "can't create the worktree $dir/worktrees/$n"; exit 1; }
  fi
  checkouts+=("$dir/worktrees/$n")
done
for worktree in "$dir"/worktrees/*; do
  n=${worktree##*/}
  [[ -e $worktree ]] || continue
  [[ $n =~ ^[0-9]+$ ]] && ((n >= 2 && n <= loops)) && continue
  (cd "$worktree" && KANBAN=$KANBAN BOARD=$BOARD STATE_DIR=$dir/state "$here/agent-loop.sh" save-work)
  git -C "$dir/repo" worktree remove --force "$worktree" 2>/dev/null || rm -rf "$worktree"
done
git -C "$dir/repo" worktree prune

# Give the agent the ultrakanban skill in each checkout, unless the repository has its own copy. It stays out of
# commits (info/exclude is shared by the clone and its worktrees).
skill=.claude/skills/ultrakanban/SKILL.md
installed_skill=$here/../skill/SKILL.md
# Run from a checkout (scripts/agent-supervisor.sh, without systemd) rather than installed: the checkout's copy.
[[ -f $installed_skill ]] || installed_skill=$here/../$skill
if [[ -f $installed_skill ]] && ! git -C "$dir/repo" ls-files --error-unmatch "$skill" >/dev/null 2>&1; then
  for checkout in "${checkouts[@]}"; do
    mkdir -p "$checkout/${skill%/*}" && cp "$installed_skill" "$checkout/$skill"
  done
  grep -qxF "/$skill" "$dir/repo/.git/info/exclude" 2>/dev/null || echo "/$skill" >>"$dir/repo/.git/info/exclude"
fi

echo "working board $BOARD on $repo as $agent/$model/$effort, $concurrency ticket(s) at a time and $conflicts more \
fixing merge conflicts"
# The loops check the board and GitHub every minute when there is nothing to do, rather than agent-loop.sh's 5 minutes,
# so a ticket added to an idle board is picked up soon.
export IDLE_SECONDS=${IDLE_SECONDS:-60}
export KANBAN BOARD AGENT=$agent MODEL=$model EFFORT=$effort STATE_DIR=$dir/state AGENT_LOOP_CLEAN=1 \
  CLAIM_LIMIT=$concurrency \
  WATCH_FILES="$here/agent-loop.sh:$(printf '%s:' "$here"/agent-loop/*.sh)$here/agent-board.sh:$installed_skill"
# The unit file too, so the loops stop for the unit to be restarted.
[[ -z $unit_file ]] || WATCH_FILES+=":$unit_file"
# agent-board.sh as it is now, to tell when it is updated.
board_script=$(stat -c '%i %Y %s' "$here/agent-board.sh" 2>/dev/null)
pids=()
trap 'kill "${pids[@]}" 2>/dev/null; wait; exit 0' INT TERM
# Starts loop n in its checkout, after the given number of seconds.
start_loop() {
  (
    sleep "${2:-0}"
    cd "${checkouts[$1]}" || exit 1
    if (($1 >= concurrency)); then
      export CONFLICTS_ONLY=1 LOOP_ID=conflicts-$(($1 - concurrency + 1))
    elif ((loops > 1)); then
      export LOOP_ID=$(($1 + 1))
    fi
    exec "$here/agent-loop.sh"
  ) &
  pids[$1]=$!
}
for n in "${!checkouts[@]}"; do
  start_loop "$n"
done

# A loop exits with status 75 when the agent scripts are updated (agent-supervisor.sh keeps them up to date). It is
# started again with the new versions on its own, so the others' runs, which can take hours, don't keep it idle (a
# short wait lets the supervisor finish copying them). When this script itself or its systemd unit is updated, the
# loops can't take it on one by one: they stop once their runs are over, and when they all have, this script starts
# again with the new version (and restarts the unit, see above).
draining=
while ((${#pids[@]})); do
  wait -n -p pid "${pids[@]}"
  code=$?
  for n in "${!pids[@]}"; do
    [[ ${pids[n]} == "$pid" ]] && break
  done
  unset 'pids[n]'
  if ((code == 75)); then
    if [[ $(stat -c '%i %Y %s' "$here/agent-board.sh" 2>/dev/null) != "$board_script" ]] || unit_outdated; then
      [[ -n $draining ]] || echo "agent-board.sh or its unit was updated; restarting once every loop finishes its run"
      draining=1
    else
      echo "loop $((n + 1)): the agent scripts were updated; starting it again with the new ones"
      start_loop "$n" 5
    fi
    continue
  fi
  echo "an agent loop stopped (status $code); stopping the others"
  kill "${pids[@]}" 2>/dev/null
  wait
  exit "$code"
done
exec "$here/agent-board.sh" "$BOARD"
