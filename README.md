# ultrakanban

A fast, keyboard-friendly kanban board for people **and** AI agents. Multiple boards, drag and drop, tags,
priorities, due dates, checklists, comments and an activity log, backed by SQLite with an atomic JSON API.

## Features

- **Boards**: create from templates, switch quickly, rename, export to and import from JSON files
- **Columns**: add, rename, recolor, reorder by drag or menu, WIP limits, delete (optionally moving tickets)
- **Tickets**: markdown description in a rich editor (headings, lists, checklists, code, links), priority,
  assignee, due date, tags, comments, full activity history, shareable links (`?ticket=<id>`)
- **View**: search, filter by priority/tag/assignee, sort by manual order, priority, due date, recency or title
  (saved per board)
- **Attachments**: screenshots and screen recordings on tickets (upload, drag and drop or paste), shown in the
  ticket and its activity
- **Pull request workflow**: agents submit tickets for review with their GitHub pull request; tickets only enter
  Done once the pull request is merged and move there automatically when it is
- **Live**: changes made by agents or other tabs show up right away (server-sent events)
- **Responsive**: works with a mouse, keyboard or touch (long-press to drag); light, dark and system themes

### Keyboard

| Key            | Action                                            |
| -------------- | ------------------------------------------------- |
| `C`            | New ticket                                        |
| `/`            | Search                                            |
| `Enter`        | Open focused ticket                               |
| `Space`        | Pick up / drop focused ticket, arrow keys to move |
| `⌘/Ctrl+Enter` | Create ticket / post comment                      |

## Running with Docker

```sh
cp .env.example .env          # set GITHUB_TOKEN (get one with: gh auth token)
docker compose up -d --build  # http://localhost:8080
```

nginx serves the app on `ULTRAKANBAN_PORT` (4317 by default) and both containers restart automatically,
including after a reboot. The database and attachments live in the `ultrakanban-data` volume.

```sh
docker compose logs -f app                            # logs
docker compose cp app:/app/data ./backup             # back up the database and attachments
docker compose down && docker compose up -d --build  # update after pulling changes

# Move an existing local board into the container
docker compose stop app
docker compose cp ./data/ultrakanban.db app:/app/data/
docker compose cp ./data/attachments app:/app/data/
docker compose start app
```

There is no authentication, so only publish it on a network you trust. To put it on the internet, terminate
TLS in front of nginx (or add a `listen 443 ssl` server block with your certificates in `deploy/nginx.conf`).

## Getting started

For development, or to run it without Docker. Requires Node.js 22.13+.

```sh
npm install
npm run dev          # http://localhost:5173 (API on :4317)
```

Production:

```sh
npm run build
npm start            # http://127.0.0.1:4317 serves the app and the API
```

| Variable                  | Default               | Purpose                                                                  |
| ------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `PORT`                    | `4317`                | API / app port                                                           |
| `HOST`                    | `127.0.0.1`           | Bind address. Use `0.0.0.0` to reach it from your phone on LAN           |
| `ULTRAKANBAN_DB`          | `data/ultrakanban.db` | SQLite database file (`:memory:` for throwaway)                          |
| `ULTRAKANBAN_ATTACHMENTS` | next to the database  | Directory for uploaded attachment files                                  |
| `GITHUB_TOKEN`            | `gh auth token`       | Token for checking pull requests (private repos need `repo` read access) |
| `GITHUB_SYNC_INTERVAL`    | `60`                  | Seconds between pull request checks                                      |

There is no authentication: only expose it on networks you trust.

## Agent API

Full reference: [`docs/API.md`](docs/API.md), also served as markdown at `GET /api` so agents can read it
themselves. In the app, **Board menu → Agent API** shows ready-to-copy commands and instructions for the
current board.

Everything is one atomic SQLite transaction, so agents can safely work in parallel:

```sh
# Add a ticket (columns and tags by name; unknown tags are created)
curl -X POST localhost:4317/api/boards/$BOARD/tickets -H 'Content-Type: application/json' -H 'X-Actor: agent-1' \
  -d '{"title":"Fix login redirect","priority":"high","tags":["bug"],"column":"Todo"}'

# Take the most important unassigned ticket and start it. Never double-assigns.
curl -X POST localhost:4317/api/boards/$BOARD/tickets/claim-next -H 'Content-Type: application/json' \
  -d '{"agent":"agent-1","column":"Todo","moveTo":"In progress"}'
```

With a review and done column configured (**Board menu → Board settings**; the Software template and boards with
columns named "Review" and "Done" get this automatically), agents finish work like this:

```sh
# Attach screenshots of visible changes to the ticket
curl -X POST localhost:4317/api/tickets/$TICKET/attachments -H 'X-Actor: agent-1' -F file=@screenshot.png

# Link the PR, post a summary, move to Review
curl -X POST localhost:4317/api/tickets/$TICKET/review -H 'Content-Type: application/json' \
  -d '{"agent":"agent-1","pullRequest":"https://github.com/acme/app/pull/42","comment":"What changed and how it was verified"}'
```

The server polls GitHub and moves the ticket to Done when the PR is merged. Moving it there earlier is rejected
(`409 pull_request_not_merged`); in the UI you can confirm to override.

`.claude/skills/ultrakanban/SKILL.md` is a ready-made Claude Code skill for this workflow: claim a ticket, read
its comments, attach screenshots, submit the pull request, and answer review feedback. Copy it to
`~/.claude/skills/ultrakanban/` to use it from any project. It also sets the rule that keeps context small:
**one ticket per agent, one agent at a time** — finish a ticket, then start a fresh agent for the next.

To work a board unattended for days, don't leave one Claude Code session looping on it: the Claude Code process
grows in memory (and swap) over a long session and only gives it back when it exits, and nothing in this project
can change that. Run the loop outside Claude Code instead, so each ticket gets its own short-lived process:

```sh
cd ~/code/my-app   # the repository the tickets are about
KANBAN=http://localhost:4317 BOARD=$BOARD ~/ultrakanban/scripts/agent-loop.sh
```

[`scripts/agent-loop.sh`](scripts/agent-loop.sh) claims the next ticket with `curl`, runs `claude -p` on it until
it is submitted for review, and waits `IDLE_SECONDS` when there is nothing to do. It needs `curl`, `jq`, `timeout`
and the skill installed. `claude -p` can't ask for permission, so allow the tools the work needs (`curl`, `git`,
`gh`, your test commands) in the project's `.claude/settings.json` or pass flags through `CLAUDE_ARGS`. A run that
fails or hits `TICKET_TIMEOUT` leaves its ticket claimed with a comment saying so. To send a ticket back for
changes, comment, move it to Todo and unassign it (or `POST /api/tickets/$TICKET/release`); the next run picks it
up with its pull request already linked.

Also: claim/release specific tickets, move to a column/position, comment, edit with optimistic concurrency
(`ifVersion`), filter tickets, and subscribe to `GET /api/events`.

## Development

```sh
npm test             # API integration tests (node:test)
npm run typecheck
npm run lint
npm run format
```

```
shared/          domain types and zod request schemas used by both sides
server/
  db.ts          SQLite connection, migrations, transactions (publishes change events after commit)
  store/         data access and domain operations (no HTTP)
  routes/        Hono routes: validate input, run store operations in a transaction
src/
  lib/           API client, pure view logic (filter/sort), optimistic cache updates
  hooks/         React Query hooks, board actions, live updates, persisted state
  components/
    board/       canvas, columns, cards, drag and drop, toolbar
    ticket/      ticket dialog, rich text editor, pickers, activity
    boards/      board switcher, settings, tags, import/export, agent API
    ui/          shadcn/ui primitives
```
