---
name: ultrakanban
description: Work tickets from an ultrakanban board - claim a ticket, read its comments, report progress, attach screenshots, open a pull request, submit it for review, and act on review feedback. Use when asked to work from the kanban board, pick up or take tickets, check the board, or when a board or ticket link is mentioned.
---

# Working from an ultrakanban board

The board is an HTTP API. Full reference: `GET $KANBAN/api` (markdown). Every write is atomic, so several
agents can work the same board safely.

## Setup

- `KANBAN` — the board's base URL, e.g. `http://localhost:8080`. Ask the user if you don't have it.
- `BOARD` — the board id. List boards with `curl -s $KANBAN/api/boards`; ask the user which one if several.
- Send `-H "X-Actor: <your name>"` on every write so the activity log shows who did what. Use the same name
  as the `agent` field.

## Working rules

- **One ticket at a time, one agent at a time.** Claim a ticket, finish it, then claim the next. Never
  claim a second ticket while one is in progress, and don't run several board agents in parallel: they
  produce conflicting branches and review noise.
- **A fresh agent per ticket.** When you are orchestrating, spawn a new subagent for each ticket and give it
  only the ticket id and this skill. Let it finish and report back before spawning the next one. This keeps
  each agent's context small — never carry one agent through several tickets.
- **Don't loop for days in one session.** A Claude Code process keeps growing in memory (and eventually swap)
  the longer it runs, even when its subagents are fresh, and only gives it back when it exits. To work a board
  unattended, switch on the board's agent instead (Board settings, with the services from the ultrakanban
  repository's `scripts/install-services.sh` installed): it runs `scripts/agent-loop.sh` outside Claude Code, which
  starts a new short-lived `claude -p` for each ticket it claims and each time one of its tickets gets feedback.
  Don't use `/loop` or a long-lived orchestrator session for this.
- **Read before you write.** Ticket comments and pull request review comments are how humans steer you.
- **Never move a ticket to the done column.** It moves there by itself when the pull request is merged.

## 1. Claim a ticket

```sh
curl -s -X POST $KANBAN/api/boards/$BOARD/tickets/claim-next \
  -H 'Content-Type: application/json' -H "X-Actor: $ME" \
  -d "{\"agent\":\"$ME\",\"column\":\"Todo\",\"moveTo\":\"In progress\"}"
```

Only one agent can win a ticket. `404 no_ticket_available` means there is nothing to do: stop and report that.
To work a specific ticket instead, use `POST /api/tickets/$TICKET/claim` with the same body minus `column`.

## 2. Read the ticket and its comments

```sh
curl -s $KANBAN/api/tickets/$TICKET            # title, description (markdown), tags, due date, pull request
curl -s $KANBAN/api/tickets/$TICKET/activity   # comments and history, oldest first
```

Follow any checklist in the description. Comments often contain corrections that are newer than the
description — treat the newest instruction as the one that counts. If they conflict with the description or
are unclear, ask in a comment and stop rather than guessing.

## 3. Work, and report as you go

Post a comment when you start something long, make a notable decision, or get blocked:

```sh
curl -s -X POST $KANBAN/api/tickets/$TICKET/comments \
  -H 'Content-Type: application/json' -H "X-Actor: $ME" -d '{"body":"<markdown>"}'
```

## 4. Attach screenshots of visible changes

If the change is visible (UI, styling, charts, CLI output), attach screenshots or a short screen recording so
reviewers can see the result without running it. PNG, JPEG, GIF, WebP, MP4 or WebM, up to 25 MB each:

```sh
curl -s -X POST $KANBAN/api/tickets/$TICKET/attachments -H "X-Actor: $ME" -F file=@screenshot.png
```

## 5. Open a pull request and submit for review

Push a branch, open the pull request, then submit the ticket with it:

```sh
curl -s -X POST $KANBAN/api/tickets/$TICKET/review \
  -H 'Content-Type: application/json' -H "X-Actor: $ME" \
  -d "{\"agent\":\"$ME\",\"pullRequest\":\"$PR_URL\",\"comment\":\"What changed and how it was verified. Screenshots attached.\"}"
```

This links the pull request, keeps the ticket yours and moves it to the review column in one step.

## 6. Answer review feedback

After submitting, check both places for feedback until the pull request is merged or you are told to stop.

```sh
curl -s $KANBAN/api/tickets/$TICKET/activity   # new ticket comments
gh pr view $PR_URL --comments                  # pull request conversation
gh api repos/$OWNER/$REPO/pulls/$NUMBER/comments   # inline review comments on the diff
gh pr checks $PR_URL                           # failing CI is feedback too
```

Address every point: push fixes, re-attach screenshots if the UI changed, reply on the pull request, and
comment on the ticket summarising what you changed. Resolve merge conflicts by merging the base branch into the
pull request's branch. Then wait for the merge — the ticket moves to the done column on its own. If the pull
request is closed without merging, comment on the ticket saying why and release it into the board's Cancelled
column: `POST /api/tickets/$TICKET/release` with `{"agent":"<you>","moveTo":"Cancelled"}` (if the board has no
such column, ask in a comment instead).

End every pull request comment, review and inline reply you post with this line, using your agent name:

```
<!-- ultrakanban:<your name> -->
```

It is invisible on GitHub. You usually post from the same GitHub account as the people reviewing you, so this
marker is how `scripts/agent-loop.sh` tells your replies apart from their feedback.

In a non-interactive run (`claude -p`, e.g. started by `scripts/agent-loop.sh`), don't wait for review: handle
the feedback the prompt lists (and anything else new), finish with a ticket comment summarising what you did,
then exit. The loop starts a new run when more feedback arrives. In the agent's own clone, the loop starts each run
on a freshly fetched checkout with no local changes: the default branch for a new ticket (create your branch from
it), or the pull request's branch for feedback on a pull request (commit on top of it and push).

Failing CI isn't always about the code. Before fixing a failing check, read the failing job's log
(`gh run view <run id> --log-failed`). If the failure doesn't come from the code (billing or spending limits,
runners that didn't start or were lost, infrastructure, a flaky test unrelated to the change, missing secrets),
don't push anything, not even an empty commit to re-trigger CI: explain what you found in a ticket comment and
stop there. A human has to fix CI.

## Handling errors

| Response                      | Meaning                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `409 already_claimed`         | Another agent got there first. Claim a different ticket.                   |
| `409 claimed_by_other`        | The ticket isn't yours; don't touch it.                                    |
| `409 version_conflict`        | Someone edited it meanwhile. Re-read the ticket and redo your edit.        |
| `409 pull_request_not_merged` | You tried to move a ticket into the done column. Don't; the merge does it. |
| `404 no_ticket_available`     | Nothing to claim right now.                                                |
| `415 unsupported_media_type`  | Attachments must be PNG, JPEG, GIF, WebP, MP4 or WebM.                     |

## Creating tickets

When asked to file work rather than do it:

```sh
curl -s -X POST $KANBAN/api/boards/$BOARD/tickets \
  -H 'Content-Type: application/json' -H "X-Actor: $ME" \
  -d '{"title":"...","description":"markdown, use - [ ] for steps","column":"Todo","priority":"high","tags":["bug"]}'
```
