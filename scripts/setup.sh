#!/usr/bin/env bash
# Sets up ultrakanban on this machine from a fresh clone:
#   scripts/setup.sh              build and start the board with docker compose (or podman-compose) on port 4317
#   scripts/setup.sh --agents     the same, plus the agents for boards that have them switched on: on Linux with
#                                 systemd, as user services on this machine (scripts/install-services.sh); elsewhere
#                                 (Windows, macOS) in the agents container
#   scripts/setup.sh --agents=container   the agents in the container, on Linux too
#   scripts/setup.sh --no-docker  without containers: install, build and start it with Node.js 22.13+ in the foreground
#
# With docker it creates .env from .env.example (GITHUB_TOKEN from `gh auth token` when gh is logged in). It is safe
# to run again: it keeps an existing .env and rebuilds the board.

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

agents=0
container=0
docker=1
for arg in "$@"; do
  case $arg in
    --agents) agents=1 ;;
    --agents=container) agents=1 container=1 ;;
    --no-docker) docker=0 ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "setup: unknown option $arg (see --help)" >&2
      exit 1
      ;;
  esac
done
if ((agents && !docker)); then
  echo "setup: --agents runs the board as a service with docker compose or podman-compose; drop --no-docker" >&2
  exit 1
fi
# Without systemd user services (Windows, macOS, containers) the agents run in their container.
if ((agents && !container)) && ! systemctl --user show-environment >/dev/null 2>&1; then
  container=1
  echo "No systemd user services here: the agents will run in a container."
fi

missing=()
need() { command -v "$1" >/dev/null || missing+=("$1 ($2)"); }
fail_missing() {
  ((${#missing[@]})) || return 0
  echo "setup: missing prerequisites:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
}

need git 'https://git-scm.com'
need curl 'your package manager'
if ((docker)); then
  if command -v podman-compose >/dev/null; then
    compose=(podman-compose)
  elif command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    compose=(docker compose)
  else
    missing+=("docker compose or podman-compose (https://docs.docker.com/engine/install/, or run with --no-docker)")
  fi
else
  need node 'Node.js 22.13+, https://nodejs.org'
  need npm 'comes with Node.js'
fi
if ((agents && !container)); then
  need gh 'GitHub CLI, https://cli.github.com, then: gh auth login'
  need jq 'your package manager'
  need claude 'Claude Code, https://claude.com/claude-code, then log in once by running: claude'
fi
fail_missing

if ((!docker)); then
  version=$(node -p 'process.versions.node')
  IFS=. read -r major minor _ <<<"$version"
  if ((major < 22 || (major == 22 && minor < 13))); then
    echo "setup: needs Node.js 22.13 or newer, found $version" >&2
    exit 1
  fi
fi
if ((agents && !container)) && ! gh auth status >/dev/null 2>&1; then
  echo "setup: gh is not logged in; run: gh auth login" >&2
  exit 1
fi

if ((!docker)); then
  npm ci
  npm run build
  # The server finds the GitHub token itself with `gh auth token`, unless GITHUB_TOKEN is set.
  echo "Starting ultrakanban on http://127.0.0.1:${PORT:-4317} (Ctrl+C stops it; data is kept in data/)"
  exec npm start
fi

# .env: settings for docker compose (port, GitHub token)
if [[ ! -f .env ]]; then
  cp .env.example .env
  if command -v gh >/dev/null && token=$(gh auth token 2>/dev/null) && [[ -n $token ]]; then
    sed -i.bak "s|^GITHUB_TOKEN=.*|GITHUB_TOKEN=$token|" .env && rm -f .env.bak
    echo "Created .env with your GitHub token from gh."
  else
    echo "Created .env. Without a GITHUB_TOKEN the board can't follow pull requests: set one in .env (gh auth token)."
  fi
fi
port=$(sed -n 's/^ULTRAKANBAN_PORT=//p' .env | tail -n 1)
port=${port:-4317}

if ((container)); then
  "${compose[@]}" --profile agents up -d --build
elif ((agents)); then
  # The service starts the board; build it first so the service's `up -d` doesn't build it with no output.
  "${compose[@]}" build
  "${compose[@]}" up -d
  scripts/install-services.sh
else
  "${compose[@]}" up -d --build
fi

url=http://localhost:$port
printf 'Waiting for %s ' "$url"
for _ in $(seq 60); do
  if curl -fs "$url/api" >/dev/null; then
    echo
    echo "ultrakanban is running at $url"
    if ((agents)); then
      ((container)) || [[ $port == 4317 ]] ||
        echo "Note: the agent services expect the board on port 4317; set ULTRAKANBAN_PORT=4317 in .env."
      if ((container)); then
        [[ -n $(sed -n 's/^GITHUB_TOKEN=//p' .env) ]] ||
          echo "The agents need a GitHub token to push: set GITHUB_TOKEN in .env, then run this again."
        "${compose[@]}" exec -T agents test -f /home/node/.claude/.credentials.json 2>/dev/null ||
          [[ -n $(sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' .env) ]] ||
          echo "Log the agents in to Claude once: ${compose[*]} exec -it agents claude (then /login, and /exit)"
      fi
      echo "To run the agent on a board: Board menu → Board settings, set the GitHub repository and switch on"
      echo "\"Run the agent on this board\"."
    else
      echo "To have it start at login and run agents on your boards: scripts/setup.sh --agents"
    fi
    exit 0
  fi
  printf .
  sleep 2
done
echo
echo "setup: the board did not answer at $url after 2 minutes; see: ${compose[*]} logs app" >&2
exit 1
