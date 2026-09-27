#!/usr/bin/env bash
# Runs agent-loop.sh for one board, in that board's own clone of its GitHub repository (never a working copy of
# yours). Started by the ultrakanban-agent@<board> systemd user unit, which agent-supervisor.sh manages.
#
# The board's agentConcurrency (1 when not set) is how many tickets it works at once: that many loops, the first in the
# clone and each other one in its own git worktree of it (worktrees/<n>), sharing one state directory. If one loop
# stops, the others are stopped too and the script exits, so systemd restarts them all. When the installed scripts or
# skill change, each loop stops before its next run, and once they all have, the script starts again with the new ones.
#
#   agent-board.sh <board id>
#
# Settings: KANBAN (default http://localhost:4317) and ULTRAKANBAN_AGENT_HOME (default
# $XDG_DATA_HOME/ultrakanban-agent). The board's clone, worktrees and loop state live in
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
effort=$(jq -r '.board.agentEffort // "high"' <<<"$board")
concurrency=$(jq -r '.board.agentConcurrency // 1' <<<"$board")
[[ $concurrency =~ ^[1-9][0-9]*$ ]] || concurrency=1
if [[ $(jq -r .board.agentEnabled <<<"$board") != true || -z $repo ]]; then
  echo "the agent is off for board $BOARD"
  exit 0
fi

mkdir -p "$dir" || exit 1
if [[ $(git -C "$dir/repo" config --get ultrakanban.repo 2>/dev/null) != "$repo" ]]; then
  echo "cloning $repo into $dir/repo"
  rm -rf "$dir/repo" "$dir/worktrees"
  gh repo clone "$repo" "$dir/repo" -- --quiet || { echo "can't clone $repo"; exit 1; }
  git -C "$dir/repo" config ultrakanban.repo "$repo"
fi

# One checkout per loop: the clone, then worktrees/2 up to worktrees/<concurrency>. Worktrees beyond that go.
checkouts=("$dir/repo")
git -C "$dir/repo" worktree prune
for ((n = 2; n <= concurrency; n++)); do
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
  [[ $n =~ ^[0-9]+$ ]] && ((n >= 2 && n <= concurrency)) && continue
  git -C "$dir/repo" worktree remove --force "$worktree" 2>/dev/null || rm -rf "$worktree"
done
git -C "$dir/repo" worktree prune

# Give the agent the ultrakanban skill in each checkout, unless the repository has its own copy. It stays out of
# commits (info/exclude is shared by the clone and its worktrees).
skill=.claude/skills/ultrakanban/SKILL.md
if [[ -f $here/../skill/SKILL.md ]] && ! git -C "$dir/repo" ls-files --error-unmatch "$skill" >/dev/null 2>&1; then
  for checkout in "${checkouts[@]}"; do
    mkdir -p "$checkout/${skill%/*}" && cp "$here/../skill/SKILL.md" "$checkout/$skill"
  done
  grep -qxF "/$skill" "$dir/repo/.git/info/exclude" 2>/dev/null || echo "/$skill" >>"$dir/repo/.git/info/exclude"
fi

echo "working board $BOARD on $repo as $agent/$model/$effort, $concurrency ticket(s) at a time"
export KANBAN BOARD AGENT=$agent MODEL=$model EFFORT=$effort STATE_DIR=$dir/state AGENT_LOOP_CLEAN=1 \
  WATCH_FILES="$here/agent-loop.sh:$here/agent-board.sh:$here/../skill/SKILL.md"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null; wait; exit 0' INT TERM
for n in "${!checkouts[@]}"; do
  (
    cd "${checkouts[n]}" || exit 1
    if ((concurrency > 1)); then export LOOP_ID=$((n + 1)); fi
    exec "$here/agent-loop.sh"
  ) &
  pids+=("$!")
done

# A loop exits with status 75 when the agent scripts are updated (agent-supervisor.sh keeps them up to date). The
# others do the same once their runs are over, and then this script starts again with the new versions.
for ((left = ${#pids[@]}; left > 0; left--)); do
  wait -n
  code=$?
  if ((code == 75)); then
    ((left == ${#pids[@]})) && echo "the agent scripts were updated; restarting once every loop finishes its run"
    continue
  fi
  echo "an agent loop stopped (status $code); stopping the others"
  kill "${pids[@]}" 2>/dev/null
  wait
  exit "$code"
done
exec "$here/agent-board.sh" "$BOARD"
