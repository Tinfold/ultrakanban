#!/usr/bin/env bash
# Sets up ultrakanban on this machine from a fresh clone:
#   scripts/setup.sh              build and start the board with docker compose (or podman-compose) on port 4317
#   scripts/setup.sh --agents     the same, plus the agents for boards that have them switched on: on Linux with
#                                 systemd, as user services on this machine (scripts/install-services.sh); elsewhere
#                                 (Windows, macOS) in the agents container
#   scripts/setup.sh --agents=container   the agents in the container, on Linux too
#   scripts/setup.sh --no-docker  without containers: install, build and start it with Node.js 22.13+ in the foreground
#
# With docker it creates .env from .env.example, with your GitHub token from gh if gh is logged in. The rest of the setup
# is on the board's Setup page (/setup), which it opens: the board's GitHub token, and the agents' GitHub and Claude
# logins, wherever they run. It is safe to run again: it keeps an existing .env, and rebuilds the board.

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
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
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
  need claude 'Claude Code, https://claude.com/claude-code'
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

# The agents on this machine use your own gh and claude logins (the Setup page logs them in if they aren't). They
# commit with git's name and email; without them every commit fails.
if ((agents && !container)); then
  if [[ -z $(git config --global user.email) ]] && gh auth status >/dev/null 2>&1 &&
    name=$(gh api user --jq '.name // .login') &&
    email=$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"'); then
    git config --global user.name "$name"
    git config --global user.email "$email"
    echo "Set git's commit name and email (git config --global) to your GitHub account's: $name <$email>"
  fi
fi

if ((!docker)); then
  npm ci
  npm run build
  # The server finds the GitHub token itself with `gh auth token`, unless GITHUB_TOKEN is set.
  [[ -n ${GITHUB_TOKEN:-} ]] || gh auth token >/dev/null 2>&1 ||
    echo "The board has no GitHub token yet: add one on its Setup page, /setup, once it runs."
  echo "Starting ultrakanban on http://127.0.0.1:${PORT:-4317} (Ctrl+C stops it; data is kept in data/)"
  exec npm start
fi

# .env: settings for docker compose (port, GitHub token)
env_get() { sed -n "s/^$1=//p" .env | tail -n 1; }
env_set() { sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; }
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env."
fi
# The board follows pull requests with the GitHub token; in the container the agents also push with it. Without gh,
# it is set on the Setup page instead.
if [[ -z $(env_get GITHUB_TOKEN) ]] && command -v gh >/dev/null && token=$(gh auth token 2>/dev/null) &&
  [[ -n $token ]]; then
  env_set GITHUB_TOKEN "$token"
  echo "Put your GitHub token from gh in .env."
fi
port=$(env_get ULTRAKANBAN_PORT)
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
  curl -fs "$url/api" >/dev/null && break
  printf .
  sleep 2
done
echo
if ! curl -fs "$url/api" >/dev/null; then
  echo "setup: the board did not answer at $url after 2 minutes; see: ${compose[*]} logs app" >&2
  exit 1
fi
echo "ultrakanban is running at $url"
echo
echo "Finish the setup in the board: $url/setup"
if ((agents)); then
  echo "It logs the board and the agents in to GitHub and Claude, and shows how to switch the agent on for a board."
else
  echo "It connects the board to GitHub. To have agents work your tickets too: scripts/setup.sh --agents"
fi
((!agents || container)) || [[ $port == 4317 ]] ||
  echo "Note: the agent services expect the board on port 4317; set ULTRAKANBAN_PORT=4317 in .env."
# Opens the Setup page when there is a desktop to open it on.
if [[ -t 1 ]]; then
  for open in xdg-open open wslview start; do
    command -v "$open" >/dev/null && { "$open" "$url/setup" >/dev/null 2>&1 & } && break
  done
fi
