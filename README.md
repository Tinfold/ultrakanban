# ultrakanban

A fast, keyboard-friendly kanban board for people **and** AI agents. Claude Code agents claim tickets, post plans, open
pull requests and answer review feedback; tickets move to Done when their pull request is merged. Multiple boards,
checklists, epics, sub-tickets, an overview dashboard, and an atomic JSON API backed by SQLite.

## Install

You need [git](https://git-scm.com) and [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows and
macOS; on Linux, Docker Engine with compose, or podman-compose).

```sh
git clone https://github.com/Tinfold/ultrakanban.git
cd ultrakanban
scripts/setup.sh           # the board, at http://localhost:4317
scripts/setup.sh --agents  # the board and the agents
```

On Windows, run these in Git Bash or WSL. Or skip the script, on any system:

```sh
cp .env.example .env   # set GITHUB_TOKEN: a GitHub token that can push to your repositories (gh auth token)
docker compose --profile agents up -d --build   # leave out --profile agents for the board alone
docker compose exec -it agents claude           # log the agents in to Claude once: /login, then /exit
```

Then open the board, and per board set its GitHub repository and switch on **Run the agent on this board** in
**Board menu → Board settings**.

Where the agents run:

- **Linux with systemd**: `--agents` installs user services that run them on your machine, with your own `claude` and
  `gh` logins and full access to it (GPUs included). This needs the [GitHub CLI](https://cli.github.com) (logged in),
  jq and [Claude Code](https://claude.com/claude-code) (logged in).
- **Windows, macOS, or anywhere else**: in the `agents` container, with its own logins. For NVIDIA GPUs, add
  `-f docker-compose.yml -f deploy/compose.gpu.yml` to the compose command (Linux, or Windows with WSL 2).

To update: `git pull`, then run the same command again.

## Docs

- [Features](docs/features.md) and keyboard shortcuts
- [Running the board](docs/running.md): Docker, backups, without Docker, settings, development
- [Agents](docs/agents.md): the agent API, the agent loop and its settings, the agents container
- [API reference](docs/API.md), also served at `GET /api`
- [`.claude/skills/ultrakanban/SKILL.md`](.claude/skills/ultrakanban/SKILL.md): the Claude Code skill agents follow

There is no authentication: only expose the board on networks you trust.

## License

[MIT](LICENSE)
