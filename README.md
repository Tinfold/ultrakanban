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
- **Merge all**: merge every pull request in review with one click, one at a time and in an order that avoids
  conflicts (stacked pull requests after the ones they build on); any that conflict after earlier merges are skipped
  for their agent to resolve
- **Quick merge**: merge a single ticket's pull request from its card in the review column
- **Overview**: a dashboard across all boards (`/overview`): which agents are working on what right now, time
  worked, tokens used and tickets completed per agent, activity, work time and token usage per day, per-board counts
  and a cross-board feed; stale or duplicate agents can be cleared from it
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

| Variable                  | Default               | Purpose                                                                                                           |
| ------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `4317`                | API / app port                                                                                                    |
| `HOST`                    | `127.0.0.1`           | Bind address. Use `0.0.0.0` to reach it from your phone on LAN                                                    |
| `ULTRAKANBAN_DB`          | `data/ultrakanban.db` | SQLite database file (`:memory:` for throwaway)                                                                   |
| `ULTRAKANBAN_ATTACHMENTS` | next to the database  | Directory for uploaded attachment files                                                                           |
| `GITHUB_TOKEN`            | `gh auth token`       | Token for checking pull requests (private repos need `repo` read access) and creating repositories (`repo` scope) |
| `GITHUB_SYNC_INTERVAL`    | `60`                  | Seconds between pull request checks                                                                               |

There is no authentication: only expose it on networks you trust.

## Agent API

Full reference: [`docs/API.md`](docs/API.md), also served as markdown at `GET /api` so agents can read it
themselves. In the app, **Board menu → Agent API** shows ready-to-copy commands and instructions for the
current board.

Everything is one atomic SQLite transaction, so agents can safely work in parallel:

```sh
# Add a ticket (columns and tags by name; unknown tags are created)
curl -X POST localhost:4317/api/boards/$BOARD/tickets -H 'Content-Type: application/json' -H 'X-Actor: claude/claude-opus-5-5/high' \
  -d '{"title":"Fix login redirect","priority":"high","tags":["bug"],"column":"Todo"}'

# Take the most important unassigned ticket and start it. Never double-assigns.
curl -X POST localhost:4317/api/boards/$BOARD/tickets/claim-next -H 'Content-Type: application/json' \
  -d '{"agent":"claude/claude-opus-5-5/high","column":"Todo","moveTo":"In progress"}'
```

With a review and done column configured (**Board menu → Board settings**; the Software template and boards with
columns named "Review" and "Done" get this automatically), agents finish work like this:

```sh
# Attach screenshots of visible changes to the ticket
curl -X POST localhost:4317/api/tickets/$TICKET/attachments -H 'X-Actor: claude/claude-opus-5-5/high' -F file=@screenshot.png

# Link the PR, post a summary, move to Review
curl -X POST localhost:4317/api/tickets/$TICKET/review -H 'Content-Type: application/json' \
  -d '{"agent":"claude/claude-opus-5-5/high","pullRequest":"https://github.com/acme/app/pull/42","comment":"What changed and how it was verified"}'
```

The server polls GitHub and moves the ticket to Done when the PR is merged. Moving it there earlier is rejected
(`409 pull_request_not_merged`); in the UI you can confirm to override.

`.claude/skills/ultrakanban/SKILL.md` is a ready-made Claude Code skill for this workflow: claim a ticket, read
its comments, attach screenshots, submit the pull request, and answer review feedback. Copy it to
`~/.claude/skills/ultrakanban/` to use it from any project. It also sets the rule that keeps context small:
**one ticket per agent, one agent at a time** — finish a ticket, then start a fresh agent for the next.

Also: claim/release specific tickets, move to a column/position, comment, edit with optimistic concurrency
(`ifVersion`), filter tickets, and subscribe to `GET /api/events`.

### Running agents unattended

Don't leave one Claude Code session looping on the board for days: the Claude Code process grows in memory (and
swap) over a long session and only gives it back when it exits, and nothing in this project can change that.
Instead, [`scripts/agent-loop.sh`](scripts/agent-loop.sh) runs the loop outside Claude Code and starts a fresh,
short-lived `claude -p` for each piece of work, so memory goes back to the OS after every run.

**Set up once, then nothing to do:**

```sh
scripts/install-services.sh
```

It installs and enables two systemd user services that start at login: `ultrakanban` (the board, as in
[Running with Docker](#running-with-docker)) and `ultrakanban-agent`, the agent supervisor. It copies the agent
scripts and the skill to `~/.local/share/ultrakanban-agent`, so run it again after updating. To keep everything
running while you are logged out, also run `loginctl enable-linger`.

Then, per board, open **Board menu → Board settings**, set the **GitHub repository** (`owner/name`, or **New** to
create one on GitHub with the server's login and link it) and switch on
**Run the agent on this board** (or `PATCH /api/boards/:id` with `githubRepo` and `agentEnabled`). The supervisor
([`scripts/agent-supervisor.sh`](scripts/agent-supervisor.sh)) checks the boards every 30 seconds and keeps one
`ultrakanban-agent@<board>` unit running per enabled board. Each loop runs one `claude -p` at a time, but the loops
of different boards run side by side, with no limit across boards: three enabled boards can mean three agents working
at once, all on your `claude` login and its usage limits. It stops the loop when the board is switched off or
deleted, and systemd restarts a loop that dies, with backoff up to 15 minutes. Each board gets its own clone,
made with `gh repo clone`, under `~/.local/share/ultrakanban-agent/boards/<board>/repo`; your own working copies
are never touched. Before every run the loop fetches and checks out the default branch (or, for feedback on a
pull request, its branch) with no local changes, and goes back to the default branch afterwards. Logs:
`journalctl --user -u ultrakanban-agent -u 'ultrakanban-agent@*' -f`.

**Names.** The board's **Agent name** (default `claude`) names the loop, which controls the work; its notes on
tickets come from `<agent>-loop`. The runs it starts claim tickets as `<agent>/<model>/<effort>`, from the board's
**Model** (default `opus`) and **Effort** (default `high`) settings, which the loop passes to `claude`. So the board
always shows which model and effort did the work, e.g. `claude/claude-opus-5-5/high`; a full model name keeps
model versions apart. A ticket can ask for its own effort (**Agent effort** in the ticket's properties, shown while
the board's agent is on); tickets that don't use the board's. When you change the model or effort, the loop
reassigns each ticket it holds to the new name before its next run on it. Agents you run yourself should follow the same pattern (see the skill).

Running the services on the host, not in the containers, is deliberate: the agents use your `claude` login, your
`gh` auth and git.

**What the loop does.** Each round, it first checks the tickets the agent holds and starts a run for one with new
feedback: a ticket comment, a pull request comment, review or inline review comment, a check on the latest commit
that ran and failed, or merge conflicts. The prompt lists exactly what is new. Bots and the agent's own replies
don't count: the agent posts from the same GitHub account as you, so the skill makes it end every pull request
comment with `<!-- ultrakanban:<agent> -->`, which the loop ignores. A pull request closed without merging moves
its ticket to the `Cancelled` column (`CANCELLED_COLUMN`; add it to the board, the loop won't fall back to Todo)
and unassigns it, so it is never picked up again. When none of its tickets needs work, it claims a new Todo ticket,
and when there is nothing to do at all it waits `IDLE_SECONDS` (60 under the supervisor).

Nothing is missed, even while a run is going: before each run the loop notes the newest ticket activity id,
pull request comment, review and inline comment ids, and the head commit's checks and conflict state. It saves
that as the ticket's watermark (one small JSON file per ticket, removed when the ticket is no longer the agent's)
only after the run succeeds. Anything newer starts the next run. A missing or unreadable state file means everything
is handed over again, never skipped.

CI failing for reasons other than the code can't make it loop. A failing check counts once per commit and check
name, so re-running CI doesn't start a run. Checks that never ran or failed around the code (`startup_failure`,
`action_required`, `timed_out`, billing or spending-limit messages, jobs where no step failed) never start a run;
the loop leaves one ticket note per commit saying CI isn't running. Cancelled, skipped and neutral checks are
ignored. On top of that, after `MAX_CI_RUNS` (default 2) runs in a row started only by CI, it stops starting CI runs
for the ticket, with a note, until someone comments. And the agent is told not to push anything when a failure
isn't from the code.

A failed run saves nothing and is retried with backoff (`RETRY_SECONDS`, doubling, up to `MAX_ATTEMPTS` in a row,
then again when new feedback arrives). Other settings are listed at the top of the script. It needs `curl`, `jq`,
`timeout`, git, an authenticated `gh` and the skill.

**Permissions:** the loop passes `--dangerously-skip-permissions`, so with the agent switched on, `claude` runs
automatically as your user on the host and can execute any command, edit any file and use the network without
asking. Run it on a machine, VM or user account that only has access to this work (Claude Code may refuse the flag
as root). `SKIP_PERMISSIONS=0` turns it off; then allow the tools the work needs in the project's
`.claude/settings.json`.

To run the loop by hand instead, start it in a dedicated clone of the repository:

```sh
KANBAN=http://localhost:4317 BOARD=$BOARD AGENT_LOOP_CLEAN=1 ~/ultrakanban/scripts/agent-loop.sh
```

`AGENT_LOOP_CLEAN=1` lets it reset the checkout before each run; leave it out in a working copy of your own.

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
