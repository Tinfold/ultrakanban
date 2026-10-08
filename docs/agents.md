# Agents

## Agent API

Full reference: [`docs/API.md`](API.md), also served as markdown at `GET /api` so agents can read it
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

## Running agents unattended

Don't leave one Claude Code session looping on the board for days: the Claude Code process grows in memory (and
swap) over a long session and only gives it back when it exits, and nothing in this project can change that.
Instead, [`scripts/agent-loop.sh`](../scripts/agent-loop.sh) runs the loop outside Claude Code and starts a fresh,
short-lived `claude -p` for each piece of work, so memory goes back to the OS after every run.

**Set up once, then nothing to do:**

```sh
scripts/install-services.sh
```

It installs and enables two systemd user services that start at login: `ultrakanban` (the board, as in
[Running with Docker](running.md#running-with-docker)) and `ultrakanban-agent`, the agent supervisor. It copies the agent
scripts and the skill to `~/.local/share/ultrakanban-agent`, and the supervisor keeps those copies up to date: when
you pull this checkout's default branch, it installs the new versions, and each agent loop switches to them before its
next run. Run the script again only when the systemd units in `deploy/` change.

**Windows, macOS, or no systemd: the agents container.** `docker compose --profile agents up -d --build` (what
`scripts/setup.sh --agents` does where there are no systemd user services) runs the supervisor and its loops in the
`agents` container ([`deploy/agents.Dockerfile`](../deploy/agents.Dockerfile)), next to the board. It has claude, git,
gh, jq, Node.js 22, Python 3 and a C toolchain; the loops run as the container's own child processes instead of
systemd units, and its home directory (claude's and gh's logins, the boards' clones) is the `ultrakanban-agent-home`
volume. Set it up once:

- `GITHUB_TOKEN` in `.env` is its GitHub login (`GH_TOKEN`): it needs write access to the boards' repositories, as
  agents push branches and open pull requests with it. Or log in inside it: `docker compose exec -it agents gh auth login`.
- Log in to Claude once: `docker compose exec -it agents claude`, then `/login` and `/exit`. Or put a token from
  `claude setup-token` in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
- GPUs: add [`deploy/compose.gpu.yml`](../deploy/compose.gpu.yml)
  (`docker compose -f docker-compose.yml -f deploy/compose.gpu.yml --profile agents up -d`) to give it the NVIDIA GPUs,
  on Linux with the NVIDIA Container Toolkit or on Windows with Docker Desktop's WSL 2 backend. Docker on macOS can't
  pass a GPU through.
- More of the machine: the agents see only their volume and the network. Mount what else they need under `volumes:`
  of the `agents` service in `docker-compose.yml`, and install other tools with your own image on top of it.

The container can't do everything the services on the machine do: it doesn't update itself from the app's update
button (pull, then run the `up` command again), and **Run the agent in Docker containers** doesn't work in it (there is
no Docker inside). Logs: `docker compose logs -f agents`.

When the agents need the machine itself (a Mac's GPU, its apps or devices), run the supervisor there without systemd:
it then keeps the loops as its own child processes. On macOS that takes the GNU tools the scripts use
(`brew install bash coreutils flock jq gh`, with `$(brew --prefix)/opt/coreutils/libexec/gnubin` first in `PATH`), and
then `scripts/agent-supervisor.sh` in a terminal that stays open. This is untested on macOS. On Windows, use WSL 2
(Ubuntu with systemd on), where it is the same as on Linux.

**Updating from the app.** Once the supervisor runs, the header shows an update button, with the version the board runs
and how many commits it is behind origin (fetched every 15 minutes). **Update & restart** asks the supervisor to
`git pull --ff-only` the checkout's default branch, rebuild and restart the board (`compose up -d --build`, as
`ultrakanban.service` runs it) and install the new agent scripts. It refuses, and says why, when the checkout has
another branch checked out or local changes. To keep everything running while you
are logged out, also run `loginctl enable-linger`.

**Claude usage.** The supervisor also reads how much of your Claude plan's usage limits is used (the current session,
the week, and any per-model weekly limit, as `/usage` in claude shows them) every 5 minutes (`CLAUDE_USAGE_SECONDS`),
with the claude login in `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`), and the overview shows it as bars of
the usage left and when each resets. The board itself can't read it: it runs in a container, without your login.

Then, per board, open **Board menu → Board settings**, set the **GitHub repository** (`owner/name`, or **New** to
create one on GitHub with the server's login and link it) and switch on
**Run the agent on this board** (or `PATCH /api/boards/:id` with `githubRepo` and `agentEnabled`). The supervisor
([`scripts/agent-supervisor.sh`](../scripts/agent-supervisor.sh)) checks the boards every 30 seconds and keeps one
`ultrakanban-agent@<board>` unit running per enabled board. It stops the loop when the board is switched off or
deleted, and systemd restarts a loop that dies, with backoff up to 15 minutes. Each board gets its own clone,
made with `gh repo clone`, under `~/.local/share/ultrakanban-agent/boards/<board>/repo`; your own working copies
are never touched. Before every run the loop fetches and checks out the default branch (detached, so create a branch
from it) or, for feedback on a pull request, its branch, with no local changes, and goes back to the default branch
afterwards. Logs: `journalctl --user -u ultrakanban-agent -u 'ultrakanban-agent@*' -f`.

Nothing should pause or slow the agents down halfway through a run. While a run goes on, the loop holds a
systemd-logind inhibitor lock, so the machine doesn't suspend or go idle (`INHIBIT_SLEEP=0` turns this off; see
`systemd-inhibit --list`). The agent units keep normal CPU and IO priority (`Nice=0`, `CPUWeight=100`,
`IOWeight=100`), and when the kernel kills a run for lack of memory, the loop carries on and retries it
(`OOMPolicy=continue`) instead of systemd stopping the whole loop. The units change only when you run
`scripts/install-services.sh` again.

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
ticket, so it takes effect without a restart. It never picks at random: from either column it takes the ticket with
the highest **priority** first, then the earliest **due date**, then the one nearest the top of the column, so set
priorities or drag tickets into the order of your roadmap to decide what it works on next. It skips blocked tickets: those tagged `blocked`, and
those whose description says they wait for another ticket (`blocked by #12`, `depends on #3 and #4`) until that ticket
is done or its pull request is merged, and tickets whose sub-tickets aren't all done yet. An agent that finds a ticket blocked marks it this way before handing it back,
so the loop doesn't keep claiming it only to find out again that it can't be done yet.

**Approval.** Each run that starts a ticket first posts a short plan with a size estimate (S, M or L), shown in the
ticket's activity and on its card. Set **Wait for approval of the plan on** (`approvalSize`) to hold large tickets, or
medium and large ones, or every ticket: the run stops after posting the plan, and the ticket waits in **In progress**
with an **Awaiting approval** badge (and in the overview's waiting list) until you press **Approve plan** on the ticket.
That starts the next run, which does the work. Comment on the ticket instead to ask for a different plan: the agent
answers and posts a revised one, and waits again. Move the ticket back to Backlog or cancel it to drop it.

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
and when there is nothing to do at all it waits `IDLE_SECONDS` (60 under the supervisor), or until the board wakes it
up: the review column's "fix conflicts" button does.

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

**Running agents in Docker:** with **Run the agent in Docker containers** (`agentDocker`) on in Board settings, the
loop starts each run's `claude -p` in a throwaway container instead of directly on the machine. The container gets the
run's checkout (at the same path), the agent's `~/.claude`, `~/.claude.json`, gh and git settings and the host's
network (to reach the board), and nothing else of the machine. A ticket can choose otherwise in its **Agent runs in**
property, either way. It needs Docker or Podman on the host (Podman, rootless or not, when Docker isn't installed, or
with `DOCKER=podman`); the default image, `ultrakanban-agent` (Node.js, Claude Code, git, gh, jq), is built the first
time a run needs it. A repository that needs more to build and test (another language, a database) needs an image of its
own with Claude Code, git and gh in it: set `DOCKER_IMAGE` for the loop, and `DOCKER_ARGS` for limits such as `--memory
8g --cpus 4`. A gh login kept in the machine's keyring reaches the container as `GH_TOKEN`.

To run the loop by hand instead, start it in a dedicated clone of the repository:

```sh
KANBAN=http://localhost:4317 BOARD=$BOARD AGENT_LOOP_CLEAN=1 ~/ultrakanban/scripts/agent-loop.sh
```

`AGENT_LOOP_CLEAN=1` lets it reset the checkout before each run; leave it out in a working copy of your own. To work
several tickets at once by hand, start one loop per checkout (the clone plus `git worktree add --detach` ones), with
the same `BOARD`, agent settings and `STATE_DIR`.

A reset keeps build output (ignored files such as `target/` or `node_modules/`) so builds stay incremental, until a
checkout's ignored files pass `MAX_BUILD_GB` (default 20): then the loop removes them all before the next run. Each
board's clone and worktree has its own, so a Rust board with several parallel runs could otherwise fill the disk.
`MAX_BUILD_GB=0` keeps them.
