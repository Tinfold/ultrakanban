# ultrakanban API

JSON over HTTP. Base URL: `http://127.0.0.1:4317/api` (in development the Vite dev server also proxies `/api`).

- Send `Content-Type: application/json` for request bodies.
- Send `X-Actor: <your-name>` on writes so the activity log shows who did what.
- Every write is a single atomic SQLite transaction: it either fully applies or not at all.
- Errors look like `{ "error": { "code": "...", "message": "...", "details": ... } }`.
  - `400 validation_error` / `bad_request` - fix the request.
  - `404 not_found` - unknown board/column/tag/ticket or route.
  - `404 no_ticket_available` - `claim-next` found nothing to claim.
  - `409 already_claimed` / `claimed_by_other` - someone else holds the ticket (`details.ticket` has its current state).
  - `409 version_conflict` - `ifVersion` did not match (`details.ticket` has its current state).
  - `409 tag_exists` - tag names are unique per board (case-insensitive).
  - `409 pull_request_not_merged` - the board's done column only accepts tickets whose pull request is merged.
  - `409 merge_in_progress` - the board's pull requests are already being merged.
  - `409 awaiting_approval` - the ticket's plan waits for a person's approval (see [Plans and approval](#plans-and-approval)).
  - `409 cannot_merge` - the ticket's pull request can't be merged now (draft, conflicts, builds on another in review).
  - `413 payload_too_large` / `415 unsupported_media_type` - attachments must be PNG, JPEG, GIF, WebP, MP4 or WebM, up to 25 MB.

Columns and tags can be referenced **by id or by name** (case-insensitive) wherever a request field says `ref`.
Unknown tag names are created automatically when creating or updating tickets.

## Recommended agent workflow

**Name yourself after what you run on.** An agent's name (the `agent` field and the `X-Actor` header) is
`<agent>/<model>/<effort>`, e.g. `claude/claude-opus-5-5/high`: the tool or board agent, then the exact model and
effort level. Use the name you were given if there is one; otherwise build it this way and never invent a new one,
so the board and its history show which model and effort did each piece of work. The board's own agent names its
runs like this from the board settings (`agentWorkerName` in `shared/domain.ts`).

1. `GET /api/boards` and pick a board. `GET /api/boards/:boardId` shows its columns, tags, tickets and workflow
   (`board.reviewColumnId`, `board.doneColumnId`).
2. Claim work atomically: `POST /api/boards/:boardId/tickets/claim-next` with
   `{ "agent": "claude/claude-opus-5-5/high", "column": "Todo", "moveTo": "In progress" }`.
   Only one agent can ever win a given ticket. Repeat on `404 no_ticket_available` later.
   `claim-next` skips blocked tickets: those tagged `blocked`, and those whose description says they wait for another
   ticket of the board (`blocked by #12`, `blocked on #12`, `depends on #3 and #4`, `waiting on #7`) until that ticket is in the
   done column (the board's last column if it has none) or its pull request is merged. It also skips tickets whose
   sub-tickets aren't all finished (see [Sub-tickets](#sub-tickets)).
   Or claim a specific ticket: `POST /api/tickets/:ticketId/claim`.
3. Read the ticket's comments (`GET /api/tickets/:ticketId/activity`) before starting: they may be newer than
   the description. Report progress and decisions with `POST /api/tickets/:ticketId/comments`.
   If the description has a checklist (`- [ ] step`), check off each step as you finish it with
   `POST /api/tickets/:ticketId/checklist/:index` rather than rewriting the description.
   Before starting the work, post a short plan with a size estimate: `POST /api/tickets/:ticketId/plan` with
   `{ "agent": "claude/claude-opus-5-5/high", "estimate": "M", "plan": "<markdown>" }`. If the returned ticket's
   `approval` is `"pending"`, stop: the board holds tickets of that size until a person approves the plan (see
   [Plans and approval](#plans-and-approval)).
4. **If the change is visible** (UI, styling, charts, CLI output), attach screenshots or a short screen recording to
   the ticket so reviewers can see the result without running it:
   `curl -X POST $API/tickets/$TICKET/attachments -H 'X-Actor: claude/claude-opus-5-5/high' -F file=@screenshot.png`.
5. Open a GitHub pull request for the work, then submit for review: `POST /api/tickets/:ticketId/review` with
   `{ "agent": "claude/claude-opus-5-5/high", "pullRequest": "https://github.com/owner/repo/pull/123", "comment": "What changed and how it was verified" }`.
   This links the pull request, keeps the ticket assigned to you and moves it to the review column in one step.
   **Questions** (tickets tagged `question`) need no pull request: submit them with just the answer,
   `{ "agent": "claude/claude-opus-5-5/high", "comment": "The answer" }`. A person closes them by moving them to the done column.
6. Keep answering feedback until the pull request is merged: re-read the ticket's activity for new comments and
   check the pull request's review comments (`gh pr view --comments`,
   `gh api repos/:owner/:repo/pulls/:number/comments`). Push fixes, reply, and summarise on the ticket.
7. **Don't move tickets to the done column yourself.** It only accepts tickets whose pull request is merged, and the
   server moves them there automatically once GitHub reports the merge.
8. To give up on a ticket, hand it back with `POST /api/tickets/:ticketId/release` `{ "agent": "claude/claude-opus-5-5/high", "moveTo": "Todo" }`.
   If you give up because it is blocked, mark it first (add `blocked by #12` to its description, or tag it `blocked`)
   so `claim-next` doesn't hand it straight back to the next agent.
   If it is too big for one pull request, split it into sub-tickets (see [Sub-tickets](#sub-tickets)) and release it.
9. For read-modify-write edits, pass the ticket's `version` as `ifVersion` so concurrent edits are rejected instead of lost.

Work **one ticket per agent, one agent at a time**: claim a ticket, finish it, then start a fresh agent for the
next one. Parallel agents produce conflicting branches, and reusing one agent across tickets fills its context.
For unattended work, start each agent as its own process from an external loop (the repository has one in
`scripts/agent-loop.sh`) rather than keeping one long-lived agent session looping over the board.
A ready-made Claude Code skill for this workflow lives in the repository at `.claude/skills/ultrakanban/`.

Boards without a review/done column (see board settings) have no pull request requirement: finish tickets with
`POST /api/tickets/:ticketId/move`.

## Pull request workflow

- The server checks linked pull requests on GitHub every minute (and right after one is linked), authenticated with
  `GITHUB_TOKEN`/`GH_TOKEN` or the `gh` CLI login. `GET /api/github` returns `{ "auth": "env" | "gh" | null }`.
- When a pull request is merged, its ticket moves to the done column (actor `github`). Closed pull requests are noted
  in the activity log; the ticket stays where it is.
- Moving a ticket into the done column without a merged pull request fails with `409 pull_request_not_merged`,
  whether through `move`, `claim`/`release` `moveTo`, or creating a ticket there. Humans can pass `force: true` to
  `move` or ticket creation to override it; agents should not.
- **Questions:** a ticket tagged `question` (case-insensitive) is answered in a comment rather than with a pull request.
  It can be submitted for review without one, and while it has no linked pull request it can move into the done
  column without `force`. A question with a linked pull request waits for its merge like any other ticket.
- **Parents:** a ticket whose sub-tickets are all finished can likewise be submitted for review and moved into the done
  column without a pull request of its own (see [Sub-tickets](#sub-tickets)).

### Merging pull requests in review

Humans can merge every open pull request in the review column at once (the merge button on the review column in the
app), or one ticket's (the merge button on its card). Agents should not: merging is the reviewer's call.

| Method | Path                          | Body                                           | Returns                                                                              |
| ------ | ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/boards/:boardId/merge-plan` |                                                | `MergePlan`: the review column's open pull requests in merge order, read from GitHub |
| POST   | `/boards/:boardId/merge-run`  | `{ method: "merge" \| "squash" \| "rebase" }`  | `202 MergeRun`, then merges in the background; `409 merge_in_progress` if one runs   |
| GET    | `/boards/:boardId/merge-run`  |                                                | the board's latest `MergeRun` since the server started, or `null`                    |
| POST   | `/tickets/:ticketId/merge`    | `{ method?: "merge" \| "squash" \| "rebase" }` | the merged `Ticket`, now in the done column; waits for the merge                     |

- **Order:** a pull request that builds on another (its base is the other's branch, or it contains the other's
  commits) merges after it; otherwise they merge in the review column's order, so dragging tickets there changes it.
- **One at a time:** after each merge the server waits for GitHub to check the next pull request again. One that
  has conflicts by then is skipped, and so is anything built on it; its agent sees the conflicts and resolves them.
  The rest still merge. A stacked pull request is retargeted to the branch its base was merged into.
- Drafts are skipped. Pull requests blocked by branch protection are still tried (admins may bypass it) and fail
  with GitHub's message if refused, as does one that gets new commits after the run started.
- **One ticket:** `POST /tickets/:ticketId/merge` merges a ticket in the review column on its own, as a one-step
  `MergeRun` (so it never overlaps "merge all"). It is refused with `409 cannot_merge` if the pull request is a draft,
  has conflicts, or builds on another pull request still in review (merge that one first), and fails with
  `502 github_error` if GitHub refuses the merge. `method` falls back to one the repository allows.
- **Auto-merge:** with the board's `autoMerge` on, the server merges the pull requests in the review column that are
  ready, each time it syncs pull requests with GitHub (`GITHUB_SYNC_INTERVAL`): open, not a draft, no conflicts,
  GitHub's `mergeable_state` `clean` (every check passed, nothing blocking), every checklist item of the ticket
  checked, and building only on pull requests that are ready too. It runs as a `MergeRun` by `auto-merge`, in the
  same order as "merge all", with the first merge method every repository allows, and only when a run has anything
  to merge and no other run is going.
- Merged tickets move to the done column right away. Merging needs a GitHub token with write access (`400` without
  one).

```ts
interface MergePlan {
  items: MergePlanItem[] // in merge order
  methods: ('merge' | 'squash' | 'rebase')[] // allowed by every repository in the plan
}

interface MergePlanItem {
  ticketId: string
  ticketNumber: number
  ticketTitle: string
  url: string
  repo: string
  number: number
  title: string | null
  base: string | null // branch it merges into
  head: string | null
  headSha: string | null
  after: string[] // ticket ids whose pull requests it builds on
  overlaps: string[] // ticket ids whose pull requests change some of the same files
  warning: string | null // may be refused, e.g. required reviews or checks missing
  skip: string | null // won't be merged: draft, conflicts, not open, built on one that won't be merged
}

interface MergeRun {
  id: string
  boardId: string
  actor: string
  method: 'merge' | 'squash' | 'rebase'
  status: 'running' | 'finished'
  startedAt: string
  finishedAt: string | null
  steps: (MergePlanItem & { status: 'pending' | 'merging' | 'merged' | 'skipped' | 'failed'; message: string | null })[]
}
```

### Fixing merge conflicts

`POST /boards/:boardId/fix-conflicts` (the "fix conflicts" button on the review column in the app) comments on every
ticket in the review column whose open pull request has merge conflicts, asking for them to be fixed, and sends a
`wake` event (see [Live updates](#live-updates)) so the board's idle agent loops look for work now. It returns
`{ tickets: Ticket[] }`, the tickets it commented on; `400` if the board has no review column.

## Types

```ts
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
type Color = 'gray' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'indigo' | 'violet' | 'pink'

interface Ticket {
  id: string
  boardId: string
  number: number // board-scoped, shown as #12
  columnId: string
  title: string
  description: string // markdown
  priority: Priority
  assignee: string | null
  dueDate: string | null // YYYY-MM-DD
  agentEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null // effort the board's agent works it at (the board's when null)
  agentModel: string | null // model the board's agent works it with, an alias or full name (the board's when null)
  tagIds: string[]
  pullRequest: PullRequest | null
  position: number // order within its column, 0-based
  version: number // increments on every change
  commentCount: number
  attachmentCount: number
  // Token usage added up over all agent runs on it (see Token usage); costUsd sums the runs that reported a cost,
  // and is null when none did
  usage: { runs: number; tokens: number; costUsd: number | null }
  run: AgentRun | null // the agent run working it right now, as its heartbeats tell (see below)
  waitingSince: string | null // when its agent started waiting on a person: the newest comment is its assignee's, or its plan is newer than every comment and waits for approval, and it isn't in review or done
  estimate: 'S' | 'M' | 'L' | null // the size its agent estimated it at in its latest plan (see Plans and approval)
  approval: 'pending' | 'approved' | null // its plan waits for approval, or has it; null when it needs none
  movedAt: string // when it entered its current column
  archived: boolean // in the done column for longer than the board's archiveDoneDays (see Boards)
  parentId: string | null // the ticket it is a sub-ticket of (see Sub-tickets)
  subtickets: { done: number; total: number } | null // its finished sub-tickets out of all but cancelled ones; null without any
  createdAt: string
  updatedAt: string
}

interface AgentRun {
  startedAt: string // its first heartbeat
  seenAt: string // its latest heartbeat
  step: string | null // what it is doing, as its agent last said
}

interface ChecklistItem {
  index: number // 0-based, among the description's checklist items
  text: string
  checked: boolean
}

interface PullRequest {
  url: string // https://github.com/owner/repo/pull/123
  repo: string // owner/repo
  number: number
  state: 'unknown' | 'open' | 'draft' | 'merged' | 'closed' // unknown until GitHub has been checked
  title: string | null
  conflicts: boolean // GitHub last found merge conflicts with its base branch (open and draft pull requests only)
  checks: 'pending' | 'passing' | 'failing' | null // combined status of its checks; null when it has none, or isn't open or draft
  checkedAt: string | null
}

interface BoardSummary {
  id: string
  name: string
  description: string
  reviewColumnId: string | null // where POST /tickets/:id/review moves tickets
  doneColumnId: string | null // only accepts tickets with a merged pull request
  githubRepo: string | null // "owner/name" the board's tickets are about
  agentEnabled: boolean // the host's agent supervisor runs an agent loop for this board
  agentName: string | null // name of that agent, the loop that controls it ("claude" when null)
  agentModel: string | null // model it runs, an alias or full name ("opus" when null)
  agentEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null // effort it runs at ("medium" when null)
  agentConcurrency: number | null // tickets it works at once, 1-8, each in its own git worktree (1 when null)
  agentBacklog: boolean // it also takes tickets from the Backlog column once Todo has none
  agentAllSkills: boolean // its runs load every skill, not only the ultrakanban skill
  autoMerge: boolean // the server merges pull requests in review once they are ready (see Pull request workflow)
  archiveDoneDays: number | null // days in the done column after which tickets are archived, 1-3650 (never when null)
  approvalSize: 'S' | 'M' | 'L' | null // smallest estimate at which the agent waits for approval of its plan (never when null)
  notifyUrl: string | null // where to notify people when a ticket needs them: ntfy, Discord or webhook URL (see Boards)
  ticketCount: number
  createdAt: string
  updatedAt: string
}
```

## Boards

| Method | Path                           | Body / query                                                                                                                                                                                                                                                                                                                                                                                                                                  | Returns                                            |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| GET    | `/boards`                      |                                                                                                                                                                                                                                                                                                                                                                                                                                               | `BoardSummary[]` (most recently updated first)     |
| POST   | `/boards`                      | `{ name, description?, columns?: string[], reviewColumn?: ref, doneColumn?: ref, githubRepo?, agentEnabled?, agentName?, agentModel?, agentEffort?, agentConcurrency?, agentBacklog?, agentAllSkills?, autoMerge?, archiveDoneDays?, notifyUrl?, approvalSize? }`                                                                                                                                                                             | `BoardSummary`                                     |
| GET    | `/boards/:boardId`             | `?archived=true`                                                                                                                                                                                                                                                                                                                                                                                                                              | `{ board, columns, tags, tickets, archivedCount }` |
| PATCH  | `/boards/:boardId`             | `{ name?, description?, reviewColumn?: ref \| null, doneColumn?: ref \| null, githubRepo?: string \| null, agentEnabled?: boolean, agentName?: string \| null, agentModel?: string \| null, agentEffort?: string \| null, agentConcurrency?: number \| null, agentBacklog?: boolean, agentAllSkills?: boolean, autoMerge?: boolean, archiveDoneDays?: number \| null, notifyUrl?: string \| null, approvalSize?: 'S' \| 'M' \| 'L' \| null }` | `BoardSummary`                                     |
| POST   | `/boards/:boardId/github-repo` | `{ name, owner?, description?, private?: boolean }`                                                                                                                                                                                                                                                                                                                                                                                           | `BoardSummary` (201)                               |
| DELETE | `/boards/:boardId`             |                                                                                                                                                                                                                                                                                                                                                                                                                                               | `204`                                              |
| GET    | `/boards/:boardId/export`      |                                                                                                                                                                                                                                                                                                                                                                                                                                               | portable board JSON                                |
| POST   | `/boards/import`               | portable board JSON                                                                                                                                                                                                                                                                                                                                                                                                                           | `BoardSummary`                                     |

`POST /boards/:boardId/github-repo` creates a repository on GitHub with the server's login and sets it as the board's
`githubRepo`. It is created under `owner` (a user or organization; the signed-in user when omitted), private unless
`private` is `false`, and with a README so it has a default branch for agents to clone and branch from. It fails with
`400 github_unauthenticated` when the server isn't signed in to GitHub, `400 github_error` when GitHub turns the
request down (e.g. the name is taken, or the token can't create repositories there; the message says why) and
`502 github_error` when GitHub can't be reached. The token needs the `repo` scope (fine-grained tokens:
Administration write), and `read:org` plus access to the organization to create one in an organization.

`agentEnabled` can only be switched on once `githubRepo` is set (`400` otherwise). It is read by
`scripts/agent-supervisor.sh`, which runs on the host and keeps one agent loop per enabled board; see the README.
The loop runs Claude Code with `agentModel` and `agentEffort` and claims tickets as
`<agentName>/<agentModel>/<agentEffort>`, e.g. `claude/opus/medium` with nothing set. A ticket's own `agentModel`
and `agentEffort` override the board's for that ticket: the loop runs it with them and under that name.
`agentConcurrency` is how many tickets the agent works at once: the host runs that many loops, each in its own git
worktree of the board's clone, and never two on the same ticket. With `agentBacklog` on, the agent takes new tickets
from the `Backlog` column once the `Todo` column has none left and the `In progress` column holds fewer than
`agentConcurrency` tickets (the loop's `TODO_COLUMN`, `BACKLOG_COLUMN` and `IN_PROGRESS_COLUMN` name them). With `agentAllSkills` off, runs only get the ultrakanban skill, unless the repository has skills of its own.

With `archiveDoneDays` set, tickets that have been in the board's done column for longer than that many days are
archived (`archived: true`): `GET /boards/:boardId` leaves them out, so the board agents read stays small, and says
how many it left out in `archivedCount`. `?archived=true` includes them (and `archivedCount` is then 0). They are still
returned by `GET /boards/:boardId/tickets` (search with `q` included), `GET /tickets/:ticketId` and the board export.
Moving a ticket out of the done column unarchives it; moving it back in starts the count again.

With `notifyUrl` set, the server sends a message there when a ticket needs a person:

- `question`: its assignee comments while working it (not in review or done), i.e. its agent waits for an answer
  (`waitingSince` is set).
- `attention`: a comment posted with `notify: true`. The agent loop does this when CI didn't run properly or it stopped
  starting runs for failing CI.
- `approval`: its agent posted a plan that waits for approval (see `approvalSize`).
- `answer`: a question ticket was submitted for review with its answer.
- `ready`: a pull request in the review column is ready to merge (open, not a draft, no conflicts, every check passed,
  every checklist item checked), checked with the pull request sync. Only on boards without `autoMerge`, which merge
  it instead.

Each is sent once: once per comment, answer or pull request commit. An ntfy topic (on `ntfy.sh`, or a server with `ntfy` as a part of its host
name, e.g. `ntfy.example.com`) gets the message with its title and link; a Discord webhook gets a Discord message; any other URL
gets a JSON `POST` of `{ kind, boardId, boardName, ticketId, ticketNumber, ticketTitle, title, message, url }`. `url`
links to the ticket when the server's `ULTRAKANBAN_URL` is set, otherwise to its pull request, if any.

## Columns and tags

| Method | Path                              | Body / query                                             | Returns                                        |
| ------ | --------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| POST   | `/boards/:boardId/columns`        | `{ name, color?, wipLimit?: number \| null, position? }` | `Column`                                       |
| PATCH  | `/columns/:columnId`              | `{ name?, color?, wipLimit? }`                           | `Column`                                       |
| POST   | `/columns/:columnId/move`         | `{ position }`                                           | `Column`                                       |
| DELETE | `/columns/:columnId`              | `?moveTicketsTo=ref` (otherwise its tickets are deleted) | `204`                                          |
| GET    | `/columns/:columnId/idle-tickets` |                                                          | `Ticket[]` idle in the column (see below)      |
| POST   | `/columns/:columnId/release-idle` | `{ moveTo: ref }`                                        | `Ticket[]` it unassigned and moved to `moveTo` |
| POST   | `/boards/:boardId/tags`           | `{ name, color? }`                                       | `Tag`                                          |
| PATCH  | `/tags/:tagId`                    | `{ name?, color? }`                                      | `Tag`                                          |
| DELETE | `/tags/:tagId`                    |                                                          | `204`                                          |

A ticket is idle when no agent has sent a heartbeat for it (`POST /tickets/:ticketId/heartbeat`) and nothing has
happened on it (no activity) for 10 minutes. `scripts/agent-loop.sh` sends one every `TICKET_CHECK_SECONDS` while a
run is working the ticket; the board offers to move a working column's idle tickets back to its todo column, e.g.
tickets whose agent stopped or crashed.

Heartbeats also make up the ticket's `run`, which its card shows: a heartbeat starts a run unless one is going on,
and can say what the run is doing (`step`; a heartbeat without one keeps the run's step). The run ends with
`DELETE /tickets/:ticketId/heartbeat`, or after 10 minutes without a heartbeat. Cards show a run as stalled after 3
minutes without one.

## Tickets

| Method | Path                                   | Body / query                                                                                                                                                                                                     | Returns                                                                                                                                                                                                                                                                                                              |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/boards/:boardId/tickets`             | `?column=ref&assignee=name&unassigned=true&tag=ref&priority=high&q=text` (`tag`, `priority` repeatable)                                                                                                          | `Ticket[]` in board order                                                                                                                                                                                                                                                                                            |
| GET    | `/boards/:boardId/tickets/:number`     |                                                                                                                                                                                                                  | `Ticket`                                                                                                                                                                                                                                                                                                             |
| POST   | `/boards/:boardId/tickets`             | `{ title, description?, column?: ref, priority?, tags?: ref[], assignee?, dueDate?, agentEffort?, agentModel?, pullRequest?: url, parent?: ref, position?, force? }`                                             | `Ticket` (defaults to the first column, appended)                                                                                                                                                                                                                                                                    |
| GET    | `/tickets/:ticketId`                   |                                                                                                                                                                                                                  | `Ticket`                                                                                                                                                                                                                                                                                                             |
| PATCH  | `/tickets/:ticketId`                   | `{ title?, description?, priority?, tags?: ref[], assignee?: string \| null, dueDate?, agentEffort?: string \| null, agentModel?: string \| null, pullRequest?: url \| null, parent?: ref \| null, ifVersion? }` | `Ticket`                                                                                                                                                                                                                                                                                                             |
| DELETE | `/tickets/:ticketId`                   |                                                                                                                                                                                                                  | `204`                                                                                                                                                                                                                                                                                                                |
| POST   | `/tickets/:ticketId/move`              | `{ column: ref, position?, ifVersion?, force? }`                                                                                                                                                                 | `Ticket` (appended when `position` is omitted)                                                                                                                                                                                                                                                                       |
| POST   | `/tickets/:ticketId/claim`             | `{ agent, moveTo?: ref, ifVersion? }`                                                                                                                                                                            | `Ticket`; `409` if claimed by someone else (idempotent for the same agent)                                                                                                                                                                                                                                           |
| POST   | `/tickets/:ticketId/release`           | `{ agent, moveTo?: ref, force? }`                                                                                                                                                                                | `Ticket`; `409` if claimed by someone else unless `force`                                                                                                                                                                                                                                                            |
| POST   | `/tickets/:ticketId/heartbeat`         | `{ step? }` (optional)                                                                                                                                                                                           | `204`; says an agent is working on the ticket right now (not a change: nothing is logged)                                                                                                                                                                                                                            |
| DELETE | `/tickets/:ticketId/heartbeat`         |                                                                                                                                                                                                                  | `204`; says the agent's run on the ticket has ended                                                                                                                                                                                                                                                                  |
| POST   | `/boards/:boardId/tickets/claim-next`  | `{ agent, column: ref, tags?: ref[], moveTo?: ref }`                                                                                                                                                             | `Ticket`: highest priority, then earliest due date, then board order, among unassigned, unblocked tickets in `column` having all `tags` (see below)                                                                                                                                                                  |
| POST   | `/tickets/:ticketId/plan`              | `{ agent, estimate: 'S' \| 'M' \| 'L', plan: markdown }`                                                                                                                                                         | `Ticket`: posts the plan, sets `estimate`, and holds the ticket for approval (`approval: 'pending'`) when the board's `approvalSize` asks for it; `409` if claimed by someone else                                                                                                                                   |
| POST   | `/tickets/:ticketId/approve`           | `{ ifVersion? }` (optional)                                                                                                                                                                                      | `Ticket` with `approval: 'approved'`; `409 not_awaiting_approval` if its plan doesn't wait for approval, `409 own_plan` when sent by its assignee                                                                                                                                                                    |
| POST   | `/tickets/:ticketId/review`            | `{ agent, pullRequest?: url, comment?: markdown, ifVersion? }`                                                                                                                                                   | `Ticket`: links the pull request, assigns `agent`, posts `comment`, moves to the review column; `409` if claimed by someone else, `400` if the board has no review column, or without `pullRequest` unless the ticket is a `question` answered in `comment`, its sub-tickets are all finished, or it already has one |
| POST   | `/tickets/:ticketId/pull-request/sync` |                                                                                                                                                                                                                  | `Ticket` after checking its pull request on GitHub now                                                                                                                                                                                                                                                               |
| GET    | `/tickets/:ticketId/checklist`         |                                                                                                                                                                                                                  | `ChecklistItem[]`: the description's task list items (`- [ ]` / `- [x]`), outside code blocks                                                                                                                                                                                                                        |
| POST   | `/tickets/:ticketId/checklist/:index`  | `{ checked?: boolean, ifVersion? }` (`checked` defaults to `true`)                                                                                                                                               | `Ticket` with the item at `index` (0-based) checked off or unchecked and the rest of the description untouched; `404` if there is no such item                                                                                                                                                                       |
| GET    | `/tickets/:ticketId/activity`          |                                                                                                                                                                                                                  | `Activity[]` (oldest first)                                                                                                                                                                                                                                                                                          |
| POST   | `/tickets/:ticketId/comments`          | `{ body, pullRequest?, notify? }` (markdown); `pullRequest: true` also posts it on the ticket's pull request (`data.pullRequestComment` links it); `notify: true` also sends the board's notification            | `Activity`                                                                                                                                                                                                                                                                                                           |
| GET    | `/tickets/:ticketId/children`          |                                                                                                                                                                                                                  | `Ticket[]`: its sub-tickets, in board order                                                                                                                                                                                                                                                                          |
| POST   | `/tickets/:ticketId/children`          | same as `POST /boards/:boardId/tickets`, without `parent`                                                                                                                                                        | `Ticket`: a sub-ticket of this one, on its board (`201`)                                                                                                                                                                                                                                                             |

### Plans and approval

When an agent starts a ticket, it posts a short plan with its estimate of the ticket's size (`S`, `M` or `L`) with
`POST /tickets/:ticketId/plan`. The plan shows in the ticket's activity (type `plan`) and the estimate on its card.
A board whose `approvalSize` is set holds tickets estimated at that size or larger for approval: the ticket's `approval`
becomes `pending`, and the agent stops there, before it spends more tokens on the ticket. Its card says it is awaiting
approval, it counts as waiting on a person (`waitingSince`), it isn't idle, and it can't be submitted for review
(`409 awaiting_approval`). A person approves the plan on the ticket (`POST /tickets/:ticketId/approve`, logged as
`approved`), which the board's agent loop takes as its go-ahead and starts a run. To change the plan, comment instead:
the agent answers and posts a revised one. A ticket stays approved when its agent posts a new plan, and stops waiting
when it is unassigned (e.g. moved back to the backlog).

### Sub-tickets

Split a ticket that is too big for one pull request into sub-tickets, each a ticket of its own that links back to it:
`POST /api/tickets/:ticketId/children` with the same body as creating a ticket (pass `"column": "Todo"` so agents
pick them up), or `parent` (the parent's id or number, `12` or `#12`) when creating or updating any ticket;
`"parent": null` unlinks one. Parents are on the same board, and a ticket can't become a sub-ticket of its own
sub-tickets. Deleting a parent unlinks its sub-tickets.

- The parent's `subtickets` counts its finished sub-tickets (in the done column, the board's last column if it has
  none, or with a merged pull request) out of all of them, leaving out those in a column named `Cancelled`. The board
  shows it on the parent's card and dialog.
- The parent waits for them: `claim-next` skips it while any is unfinished, like a ticket that says `blocked by`.
  An agent that splits a ticket releases it (back to Todo) once the sub-tickets exist.
- Once they are all finished, `claim-next` hands the parent out again, to do whatever is left of it. If nothing is,
  submit it for review with a summary as the `comment` and no pull request; a person moves it to the done column.

## Token usage

Agents report the tokens each run used on a ticket, and the [overview](#overview) adds them up per agent, board and
day. `scripts/agent-loop.sh` reports every `claude -p` run it starts (from `--output-format json`, all models the run
called, subagents included); other agents can report theirs the same way. Runs that weren't on a ticket (an assistant
answering a question, say) are reported to the board instead, and count toward the agent's and the board's totals just
the same, with `ticketId: null`. Every ticket carries its runs' totals in `usage`.

A run can also say how its tokens split between the models it called (`models`, one entry per model, from
`claude -p`'s `modelUsage`; the agent loop sends it), so the overview can show token usage by model. The overview
counts a run that doesn't as one of the model in its agent's name (`opus` for `claude/opus/high`), or of `unknown`.

| Method | Path                       | Body                                                                                                                                                                                               | Returns                                              |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| POST   | `/tickets/:ticketId/usage` | `{ agent, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd?, durationMs?, models?: { model, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd? }[] }` | `TokenUsage` (201)                                   |
| GET    | `/tickets/:ticketId/usage` |                                                                                                                                                                                                    | `TokenUsage[]` (oldest first)                        |
| POST   | `/boards/:boardId/usage`   | same as for a ticket                                                                                                                                                                               | `TokenUsage` (201) with `ticketId: null`             |
| GET    | `/boards/:boardId/usage`   |                                                                                                                                                                                                    | `TokenUsage[]` (oldest first), on its tickets or not |

```ts
interface TokenUsage {
  id: number
  boardId: string
  ticketId: string | null // null for runs reported to the board rather than a ticket
  agent: string // who ran, e.g. claude/opus/high
  inputTokens: number // uncached input
  outputTokens: number
  cacheReadTokens: number // input read from the prompt cache
  cacheWriteTokens: number // input written to the prompt cache
  costUsd: number | null // estimated cost, if the agent reported one
  durationMs: number | null
  // The same split by model (e.g. claude-opus-5-5), most tokens first; empty if the agent didn't report it
  models: { model; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; costUsd: number | null }[]
  createdAt: string
}
```

### Suggested model and effort

`GET /boards/:boardId/agent-suggestion?title=text&tag=ref&steps=3` suggests a model and effort for a ticket about to be
created, from how the board's similar tickets went (the new-ticket form shows it). `tag` is repeatable (ids or names;
ones the board doesn't have are ignored) and `steps` is how many checklist steps its description has (leave it out
when unknown).

- **Past tickets** count once they are decided: finished (in the done column or with a merged pull request), or given
  up on (in the cancelled column, or with their pull request closed unmerged). Each counts at the setting of the
  `<agent>/<model>/<effort>` name whose runs used the most tokens on it, with the cost of all its runs.
- **Similar** means sharing tags (45%) or title words (45%, stop words left out); a similar number of checklist steps
  adds up to 10% but isn't enough alone. The 20 most similar count, each weighted by its similarity.
- **The suggestion** is the cheapest setting (by cost, or by tokens when runs reported no cost) whose weighted success
  rate is within 0.2 of the best one's, so a cheaper setting that finishes the same kind of work wins and one that
  keeps failing doesn't. It is `null` when no similar ticket was finished.

```ts
interface AgentSuggestion {
  suggestion: AgentSettingStats | null
  options: AgentSettingStats[] // every setting similar tickets were worked at, the suggestion first
}

interface AgentSettingStats {
  model: string // e.g. sonnet
  effort: string // e.g. medium
  tickets: number // similar decided tickets worked at it
  finished: number // how many of them were finished
  successRate: number // finished share, weighted by similarity (0 to 1)
  costUsd: number | null // average cost per ticket; null when none reported one
  tokens: number // average tokens per ticket
  similar: { id; number; title; similarity; finished; costUsd: number | null; tokens }[] // most similar first, at most 5
}
```

## Attachments

Screenshots and screen recordings on tickets. Upload one file per request as `multipart/form-data` in a field named
`file`; the type is detected from the file contents (PNG, JPEG, GIF, WebP, MP4 or WebM, up to 25 MB). Uploads and
deletions appear in the ticket's activity. Attachments are not included in board exports.

| Method | Path                             | Body             | Returns                       |
| ------ | -------------------------------- | ---------------- | ----------------------------- |
| POST   | `/tickets/:ticketId/attachments` | multipart `file` | `Attachment`                  |
| GET    | `/tickets/:ticketId/attachments` |                  | `Attachment[]` (oldest first) |
| GET    | `/attachments/:attachmentId`     |                  | the file                      |
| DELETE | `/attachments/:attachmentId`     |                  | `204`                         |

```ts
interface Attachment {
  id: string
  ticketId: string
  filename: string
  contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'video/mp4' | 'video/webm'
  size: number // bytes
  actor: string
  createdAt: string
  url: string // /api/attachments/:id, also usable in markdown: ![screenshot](/api/attachments/:id)
}
```

## Overview

`GET /overview?days=7|14|30` (default `14`) aggregates every board over the last `days` days:

```ts
interface Overview {
  generatedAt: string
  since: string // start of the range
  days: 7 | 14 | 30
  totals: { boards; open; working; review; completed; activeAgents; workedMs; usage: UsageTotals } // numbers
  agents: {
    name: string
    status: 'working' | 'review' | 'idle'
    tickets: {
      id
      boardId
      boardName
      number
      title
      column
      state: 'working' | 'review'
      since: string
      waitingSince: string | null // as on the ticket
      approval: 'pending' | 'approved' | null // as on the ticket
      pullRequest: { url; state } | null
    }[]
    workedMs: number // within the range; ongoing work counts up to generatedAt
    completed: number // tickets that reached the done column while assigned to it, within the range
    actions: number // activity entries it authored within the range
    lastActiveAt: string | null
    agentOf: string[] // ids of boards whose host agent runs under this name
    usage: UsageTotals // tokens its runs used within the range
  }[]
  hiddenAgents: string[] // names cleared from `agents` (see below)
  boards: { id; name; agentEnabled; agentName; open; working; review; completed; events; tokens; lastActivityAt }[]
  events: { at: string; kind: 'created' | 'completed' | 'comment' | 'update'; actor: string; boardId: string }[]
  sessions: { agent; ticketId; boardId; start: string; end: string | null }[] // clipped to the range
  completions: { ticketId; boardId; at: string; cycleMs: number | null; reviewMs: number | null }[] // oldest first
  // Token usage reported within the range, oldest first
  // (ticketId is null for runs reported to a board rather than a ticket)
  // (models as in TokenUsage; a run that didn't report them has one entry for the model in its agent's name, or unknown)
  usage: {
    at
    agent
    ticketId
    boardId
    inputTokens
    outputTokens
    cacheReadTokens
    cacheWriteTokens
    costUsd
    models
  }[]
  // Tickets with runs within the range, most tokens first, with the usage of all their runs (as in Ticket)
  tickets: { id; boardId; boardName; number; title; column: string; tags: Tag[]; usage }[]
  recent: (Activity & { ticket: { number; title; boardId; boardName } })[] // latest 30, newest first
}

// Token usage added up over runs; costUsd sums the runs that reported a cost.
interface UsageTotals {
  inputTokens
  outputTokens
  cacheReadTokens
  cacheWriteTokens
  costUsd
  runs
  models: Record<string, { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; costUsd; runs }> // by model
}
```

Agents are everyone holding a ticket that isn't done, everyone who worked or reported token usage within the range,
and the host agent of every board that has it switched on. A ticket is being **worked** while it is assigned and outside the board's
review and done columns (a board without a done column uses its last column), so claiming starts the clock and
submitting for review, merging or releasing stops it. Work time is reconstructed from the activity log. Each
completion's `cycleMs` runs from when work on the ticket started to done, and `reviewMs` from when it last entered
the review column to done; either is `null` if the ticket skipped that step.

Stale or duplicate agent names can be cleared from the list: `POST /overview/hidden-agents` with
`{ "names": ["..."] }` (204) hides them until they next do something on a board (any new activity entry by that
actor), and `DELETE /overview/hidden-agents` (204) lists every cleared agent again. Totals, charts and sessions still
include their work.

## Live updates

`GET /events?board=:boardId` is a server-sent event stream. It emits `change` events with data `{ "boardId": "..." }`
after every committed change (omit `board` to receive all boards), `wake` events with the same data when someone
asks the board's agent to look for work now (`scripts/agent-loop.sh` ends its idle wait on one), plus periodic `ping`
events.

## Examples

```sh
API=http://127.0.0.1:4317/api
BOARD=<board id>

# Add a ticket
curl -s -X POST $API/boards/$BOARD/tickets -H 'Content-Type: application/json' -H 'X-Actor: claude/claude-opus-5-5/high' \
  -d '{"title":"Fix login redirect","description":"Steps:\n- [ ] reproduce\n- [ ] fix","priority":"high","tags":["bug"],"column":"Todo"}'

# Take the next ticket and start it
curl -s -X POST $API/boards/$BOARD/tickets/claim-next -H 'Content-Type: application/json' \
  -d '{"agent":"claude/claude-opus-5-5/high","column":"Todo","moveTo":"In progress"}'

# Attach a screenshot of the result
curl -s -X POST $API/tickets/$TICKET/attachments -H 'X-Actor: claude/claude-opus-5-5/high' -F file=@screenshot.png

# Submit it for review with the pull request
curl -s -X POST $API/tickets/$TICKET/review -H 'Content-Type: application/json' -H 'X-Actor: claude/claude-opus-5-5/high' \
  -d '{"agent":"claude/claude-opus-5-5/high","pullRequest":"https://github.com/owner/repo/pull/123","comment":"Fixed the redirect loop; screenshots attached."}'
# It moves to Done by itself once the pull request is merged.
```
