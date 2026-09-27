#!/usr/bin/env bash
# Installs and enables the systemd user services, so the board and its agents start by themselves at login:
#   ultrakanban.service         the board (podman-compose or docker compose on this checkout's docker-compose.yml)
#   ultrakanban-agent.service   the agent supervisor, which runs ultrakanban-agent@<board> for boards with the agent on
# The agent scripts and the skill are copied to ~/.local/share/ultrakanban-agent, so the services don't depend on
# which branch this checkout is on. The supervisor updates those copies itself when this checkout's default branch
# moves (when you pull); run this again only after the systemd units in deploy/ change.
#
# To keep them running while you are logged out: loginctl enable-linger

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
home=${XDG_DATA_HOME:-$HOME/.local/share}/ultrakanban-agent
if command -v podman-compose >/dev/null; then
  compose=$(command -v podman-compose)
elif docker compose version >/dev/null 2>&1; then
  compose="$(command -v docker) compose"
else
  echo "install-services: needs podman-compose or docker compose" >&2
  exit 1
fi

mkdir -p "$units" "$home/bin" "$home/skill"
install -m 755 "$repo/scripts/agent-loop.sh" "$repo/scripts/agent-board.sh" "$repo/scripts/agent-supervisor.sh" \
  "$home/bin/"
install -m 644 "$repo/.claude/skills/ultrakanban/SKILL.md" "$home/skill/"
# Where the copies came from, for agent-supervisor.sh to update them when the default branch moves.
branch=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || branch=origin/main
commit=$(git -C "$repo" rev-parse --verify --quiet "${branch#origin/}^{commit}" 2>/dev/null) || commit=
printf '%s\n%s\n' "$repo" "$commit" >"$home/installed-from"
sed -e "s|@REPO@|$repo|g" -e "s|@COMPOSE@|$compose|g" "$repo/deploy/ultrakanban.service" >"$units/ultrakanban.service"
install -m 644 "$repo/deploy/ultrakanban-agent.service" "$repo/deploy/ultrakanban-agent@.service" "$units/"

systemctl --user daemon-reload
systemctl --user enable ultrakanban.service ultrakanban-agent.service
systemctl --user start ultrakanban.service # no-op if the board is already up
systemctl --user restart ultrakanban-agent.service # picks up new scripts; restarts the agent loops too

echo "Installed. The board and the agent supervisor start at login."
echo "Logs: journalctl --user -u ultrakanban-agent -u 'ultrakanban-agent@*' -f"
if [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) != yes ]]; then
  echo "To keep them running while you are logged out: loginctl enable-linger"
fi
