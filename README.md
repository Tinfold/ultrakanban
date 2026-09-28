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
- **Auto-merge**: optionally, per board, merge pull requests in review by themselves once they have no conflicts,
  every check has passed and every checklist item of their ticket is checked
- **Overview**: a dashboard across all boards (`/overview`): which agents are working on what right now, time
  worked, tokens used and tickets completed per agent, activity, work time and token usage per day (by type and by model, e.g. Opus or Haiku), per-board counts
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
scripts and the skill to `~/.local/share/ultrakanban-agent`, and the supervisor keeps those copies up to date: when
you pull this checkout's default branch, it installs the new versions, and each agent loop switches to them before its
next run. Run the script again only when the systemd units in `deploy/` change. To keep everything running while you
are logged out, also run `loginctl enable-linger`.

Then, per board, open **Board menu → Board settings**, set the **GitHub repository** (`owner/name`, or **New** to
create one on GitHub with the server's login and link it) and switch on
**Run the agent on this board** (or `PATCH /api/boards/:id` with `githubRepo` and `agentEnabled`). The supervisor
([`scripts/agent-supervisor.sh`](scripts/agent-supervisor.sh)) checks the boards every 30 seconds and keeps one
`ultrakanban-agent@<board>` unit running per enabled board. It stops the loop when the board is switched off or
deleted, and systemd restarts a loop that dies, with backoff up to 15 minutes. Each board gets its own clone,
made with `gh repo clone`, under `~/.local/share/ultrakanban-agent/boards/<board>/repo`; your own working copies
are never touched. Before every run the loop fetches and checks out the default branch (detached, so create a branch
from it) or, for feedback on a pull request, its branch, with no local changes, and goes back to the default branch
afterwards. Logs: `journalctl --user -u ultrakanban-agent -u 'ultrakanban-agent@*' -f`.

**Parallel runs.** By default a board's agent runs one `claude -p` at a time. The board's **Parallel runs** setting
(`agentConcurrency`, up to 8) lets it work that many tickets at once: the unit then runs that many loops, the first in
the clone and each other one in its own git worktree of it (`boards/<board>/worktrees/<n>`), so their branches and
files never get in each other's way. The loops share the board's state and lock each ticket while they look at it or
work it, so two runs never work the same ticket, and when one runs out of Claude usage they all wait. They claim at most
that many new tickets at a time, too: a claimed ticket whose run fails stays in progress to be retried, and until its
run succeeds (or someone moves it back to Todo) it takes up one of the slots, so runs that keep failing don't drag the
whole Todo or Backlog column into progress. Changing the
setting restarts the board's loops, which stops runs in progress (they are resumed, see below). The boards themselves
also run side by side, with no limit across boards: three enabled boards with two parallel runs each can mean six
agents working at once, all on your `claude` login and its usage limits.

**Backlog.** The agent claims new tickets from the **Todo** column. Switch on **Take tickets from Backlog when Todo is
empty** (`agentBacklog`) to let it go on to the **Backlog** column once Todo has none left, as long as the **In
progress** column holds fewer tickets than **Parallel runs**: tickets already in progress take up the slots, so the
backlog isn't pulled into progress while they're being worked. The loop reads the setting each time it looks for a
ticket, so it takes effect without a restart. From either column it skips blocked tickets: those tagged `blocked`, and
those whose description says they wait for another ticket (`blocked by #12`, `depends on #3 and #4`) until that ticket
is done or its pull request is merged. An agent that finds a ticket blocked marks it this way before handing it back,
so the loop doesn't keep claiming it only to find out again that it can't be done yet.

**Names.** The board's **Agent name** (default `claude`) names the loop, which controls the work; its notes on
tickets come from `<agent>-loop`. The runs it starts claim tickets as `<agent>/<model>/<effort>`, from the board's
**Model** (default `opus`) and **Effort** (default `medium`) settings, which the loop passes to `claude`. So the board
always shows which model and effort did the work, e.g. `claude/claude-opus-5-5/high`; a full model name keeps
model versions apart. A ticket can ask for its own model and effort (**Agent model** and **Agent effort** in the
ticket's properties, shown while the board's agent is on), e.g. `sonnet` for copy changes or `high` for a hard bug;
tickets that don't use the board's. Agents that file tickets pick a model and effort for each one from how hard it
looks (the skill's "Creating tickets" section has the guide). When you change the model or effort, the loop
reassigns each ticket it holds to the new name before its next run on it. Agents you run yourself should follow the same pattern (see the skill).

Running the services on the host, not in the containers, is deliberate: the agents use your `claude` login, your
`gh` auth and git.

**What the loop does.** Each round, it first checks the tickets the agent holds and starts a run for one with new
feedback: a ticket comment, a pull request comment, review or inline review comment, a check on the latest commit
that ran and failed, merge conflicts, or someone moving the ticket back into In progress (e.g. from Review, to
ask for more work). The prompt lists exactly what is new. Bots and the agent's own replies
don't count: the agent posts from the same GitHub account as you, so the skill makes it end every pull request
comment with `<!-- ultrakanban:<agent> -->`, which the loop ignores. A pull request closed without merging moves
its ticket to the `Cancelled` column (`CANCELLED_COLUMN`; add it to the board, the loop won't fall back to Todo)
and unassigns it, so it is never picked up again. When none of its tickets needs work, it claims a new Todo ticket,
and when there is nothing to do at all it waits `IDLE_SECONDS` (60 under the supervisor).

You can drag the agent's tickets like any other. A ticket you move back to Todo (`TODO_COLUMN`), or to a column
before it such as Backlog, goes back to the queue: the loop releases it, with a note, and forgets its state, so it is
claimed again from Todo like any other ticket (park it in Backlog to keep it from being picked up). While a run is
going, the loop checks its ticket every `TICKET_CHECK_SECONDS` (30), and stops the run, with a note, as soon as
someone takes the ticket away: moves it back to the queue like that, to Cancelled or Done, unassigns or reassigns it,
or deletes it. Moving a ticket back into In progress asks for more work (see above). Moving one into Review changes
nothing, and the loop leaves tickets it doesn't hold alone, so dragging a Todo ticket to In progress yourself keeps it
away from the agent.

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
then again when new feedback arrives), with a ticket note saying why it failed. Running out of Claude usage doesn't
count as a failure: the note quotes claude's limit message, and the loop starts no runs on any ticket until the time
the message says the limit resets.

Runs that don't finish pick up where they left off. Each run is a `claude` session whose id the loop keeps with the
ticket until the run ends. When a run is cut short by the usage limit, or by the loop stopping (restarting the service,
changing the board's agent settings, a reboot or a crash), the ticket's next run resumes that session with
`claude --resume`, so it still knows what it read, decided and did, even when another of the board's loops picks it
up. (A run that failed or timed out gets a new session instead, since resuming it would likely fail the same way.) The
work such a run left in the checkout is kept too: before the loop cleans a checkout it saves an unfinished run's
branch, local commits and uncommitted changes, untracked files included, under `refs/ultrakanban/work/<ticket>` in
the board's clone, and puts them back before the ticket's next run, telling the agent. Worktrees removed when
**Parallel runs** goes down have theirs saved first. Other settings are listed at the top of the script. It needs `curl`, `jq`,
`timeout`, git, an authenticated `gh` and the skill.

**Permissions:** the loop passes `--dangerously-skip-permissions`, so with the agent switched on, `claude` runs
automatically as your user on the host and can execute any command, edit any file and use the network without
asking. Run it on a machine, VM or user account that only has access to this work (Claude Code may refuse the flag
as root). `SKIP_PERMISSIONS=0` turns it off; then allow the tools the work needs in the project's
`.claude/settings.json`.

**MCP servers:** runs load none (`--strict-mcp-config`), since every request of a run carries their tools and
instructions. To give the agent some, pass them with `CLAUDE_ARGS="--mcp-config <file>"`, or set `STRICT_MCP=0` to
load the usual ones (the account's connectors, plugins' and the repository's `.mcp.json`).

**Keeping runs small:** each request of a run sends the whole conversation again (mostly as prompt cache reads), so a
run costs about its number of requests times its context. Besides loading no MCP servers, the loop:

- gives runs only the ultrakanban skill, in their system prompt, instead of listing every skill of the account and its
  plugins in each request. A repository with skills or commands of its own under `.claude/` keeps them all, and so does
  a board with **Load all skills in agent runs** (`agentAllSkills`) on.
- leaves out tools a run has no use for, such as scheduling and worktree tools (`DISALLOWED_TOOLS`).
- caps how much of a file one read returns (10k tokens) and how much command output a run sees (15k characters), so
  one big read doesn't ride along with every later request (`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` and
  `BASH_MAX_OUTPUT_LENGTH`).

To run the loop by hand instead, start it in a dedicated clone of the repository:

```sh
KANBAN=http://localhost:4317 BOARD=$BOARD AGENT_LOOP_CLEAN=1 ~/ultrakanban/scripts/agent-loop.sh
```

`AGENT_LOOP_CLEAN=1` lets it reset the checkout before each run; leave it out in a working copy of your own. To work
several tickets at once by hand, start one loop per checkout (the clone plus `git worktree add --detach` ones), with
the same `BOARD`, agent settings and `STATE_DIR`.

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
