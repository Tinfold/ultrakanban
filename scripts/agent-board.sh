#!/usr/bin/env bash
# Runs agent-loop.sh for one board, in that board's own clone of its GitHub repository (never a working copy of
# yours). Started by the ultrakanban-agent@<board> systemd user unit, which agent-supervisor.sh manages.
#
#   agent-board.sh <board id>
#
# Settings: KANBAN (default http://localhost:4317) and ULTRAKANBAN_AGENT_HOME (default
# $XDG_DATA_HOME/ultrakanban-agent). The board's clone and loop state live in $ULTRAKANBAN_AGENT_HOME/boards/<board>.

set -uo pipefail

BOARD=${1:?usage: agent-board.sh <board id>}
KANBAN=${KANBAN:-http://localhost:4317}
AGENT_HOME=${ULTRAKANBAN_AGENT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ultrakanban-agent}
here=$(dirname "$(readlink -f "$0")")
dir=$AGENT_HOME/boards/$BOARD

board=$(curl -sf "$KANBAN/api/boards/$BOARD") || { echo "can't read board $BOARD from $KANBAN"; exit 1; }
repo=$(jq -r '.board.githubRepo // ""' <<<"$board")
agent=$(jq -r '.board.agentName // "claude"' <<<"$board")
if [[ $(jq -r .board.agentEnabled <<<"$board") != true || -z $repo ]]; then
  echo "the agent is off for board $BOARD"
  exit 0
fi

mkdir -p "$dir" || exit 1
if [[ $(git -C "$dir/repo" config --get ultrakanban.repo 2>/dev/null) != "$repo" ]]; then
  echo "cloning $repo into $dir/repo"
  rm -rf "$dir/repo"
  gh repo clone "$repo" "$dir/repo" -- --quiet || { echo "can't clone $repo"; exit 1; }
  git -C "$dir/repo" config ultrakanban.repo "$repo"
fi

# Give the agent the ultrakanban skill in its clone, unless the repository has its own copy. It stays out of commits.
skill=.claude/skills/ultrakanban/SKILL.md
if [[ -f $here/../skill/SKILL.md ]] && ! git -C "$dir/repo" ls-files --error-unmatch "$skill" >/dev/null 2>&1; then
  mkdir -p "$dir/repo/${skill%/*}" && cp "$here/../skill/SKILL.md" "$dir/repo/$skill"
  grep -qxF "/$skill" "$dir/repo/.git/info/exclude" 2>/dev/null || echo "/$skill" >>"$dir/repo/.git/info/exclude"
fi

cd "$dir/repo" || exit 1
echo "working board $BOARD on $repo as $agent"
export KANBAN BOARD AGENT=$agent STATE_DIR=$dir/state AGENT_LOOP_CLEAN=1
exec "$here/agent-loop.sh"
