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
   Or claim a specific ticket: `POST /api/tickets/:ticketId/claim`.
3. Read the ticket's comments (`GET /api/tickets/:ticketId/activity`) before starting: they may be newer than
   the description. Report progress and decisions with `POST /api/tickets/:ticketId/comments`.
4. **If the change is visible** (UI, styling, charts, CLI output), attach screenshots or a short screen recording to
   the ticket so reviewers can see the result without running it:
   `curl -X POST $API/tickets/$TICKET/attachments -H 'X-Actor: claude/claude-opus-5-5/high' -F file=@screenshot.png`.
5. Open a GitHub pull request for the work, then submit for review: `POST /api/tickets/:ticketId/review` with
   `{ "agent": "claude/claude-opus-5-5/high", "pullRequest": "https://github.com/owner/repo/pull/123", "comment": "What changed and how it was verified" }`.
   This links the pull request, keeps the ticket assigned to you and moves it to the review column in one step.
6. Keep answering feedback until the pull request is merged: re-read the ticket's activity for new comments and
   check the pull request's review comments (`gh pr view --comments`,
   `gh api repos/:owner/:repo/pulls/:number/comments`). Push fixes, reply, and summarise on the ticket.
7. **Don't move tickets to the done column yourself.** It only accepts tickets whose pull request is merged, and the
   server moves them there automatically once GitHub reports the merge.
8. To give up on a ticket, hand it back with `POST /api/tickets/:ticketId/release` `{ "agent": "claude/claude-opus-5-5/high", "moveTo": "Todo" }`.
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
  tagIds: string[]
  pullRequest: PullRequest | null
  position: number // order within its column, 0-based
  version: number // increments on every change
  commentCount: number
  attachmentCount: number
  createdAt: string
  updatedAt: string
}

interface PullRequest {
  url: string // https://github.com/owner/repo/pull/123
  repo: string // owner/repo
  number: number
  state: 'unknown' | 'open' | 'draft' | 'merged' | 'closed' // unknown until GitHub has been checked
  title: string | null
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
  agentEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null // effort it runs at ("high" when null)
  ticketCount: number
  createdAt: string
  updatedAt: string
}
```

## Boards

| Method | Path                      | Body / query                                                                                                                                                                                                                | Returns                                        |
| ------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| GET    | `/boards`                 |                                                                                                                                                                                                                             | `BoardSummary[]` (most recently updated first) |
| POST   | `/boards`                 | `{ name, description?, columns?: string[], reviewColumn?: ref, doneColumn?: ref, githubRepo?, agentEnabled?, agentName?, agentModel?, agentEffort? }`                                                                       | `BoardSummary`                                 |
| GET    | `/boards/:boardId`        |                                                                                                                                                                                                                             | `{ board, columns, tags, tickets }`            |
| PATCH  | `/boards/:boardId`        | `{ name?, description?, reviewColumn?: ref \| null, doneColumn?: ref \| null, githubRepo?: string \| null, agentEnabled?: boolean, agentName?: string \| null, agentModel?: string \| null, agentEffort?: string \| null }` | `BoardSummary`                                 |
| DELETE | `/boards/:boardId`        |                                                                                                                                                                                                                             | `204`                                          |
| GET    | `/boards/:boardId/export` |                                                                                                                                                                                                                             | portable board JSON                            |
| POST   | `/boards/import`          | portable board JSON                                                                                                                                                                                                         | `BoardSummary`                                 |

`agentEnabled` can only be switched on once `githubRepo` is set (`400` otherwise). It is read by
`scripts/agent-supervisor.sh`, which runs on the host and keeps one agent loop per enabled board; see the README.
The loop runs Claude Code with `agentModel` and `agentEffort` and claims tickets as
`<agentName>/<agentModel>/<agentEffort>`, e.g. `claude/opus/high` with nothing set. A ticket's own `agentEffort`
overrides the board's for that ticket: the loop runs it at that effort and under that name.

## Columns and tags

| Method | Path                       | Body / query                                             | Returns  |
| ------ | -------------------------- | -------------------------------------------------------- | -------- |
| POST   | `/boards/:boardId/columns` | `{ name, color?, wipLimit?: number \| null, position? }` | `Column` |
| PATCH  | `/columns/:columnId`       | `{ name?, color?, wipLimit? }`                           | `Column` |
| POST   | `/columns/:columnId/move`  | `{ position }`                                           | `Column` |
| DELETE | `/columns/:columnId`       | `?moveTicketsTo=ref` (otherwise its tickets are deleted) | `204`    |
| POST   | `/boards/:boardId/tags`    | `{ name, color? }`                                       | `Tag`    |
| PATCH  | `/tags/:tagId`             | `{ name?, color? }`                                      | `Tag`    |
| DELETE | `/tags/:tagId`             |                                                          | `204`    |

## Tickets

| Method | Path                                   | Body / query                                                                                                                                                  | Returns                                                                                                                                                                   |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/boards/:boardId/tickets`             | `?column=ref&assignee=name&unassigned=true&tag=ref&priority=high&q=text` (`tag`, `priority` repeatable)                                                       | `Ticket[]` in board order                                                                                                                                                 |
| GET    | `/boards/:boardId/tickets/:number`     |                                                                                                                                                               | `Ticket`                                                                                                                                                                  |
| POST   | `/boards/:boardId/tickets`             | `{ title, description?, column?: ref, priority?, tags?: ref[], assignee?, dueDate?, agentEffort?, pullRequest?: url, position?, force? }`                     | `Ticket` (defaults to the first column, appended)                                                                                                                         |
| GET    | `/tickets/:ticketId`                   |                                                                                                                                                               | `Ticket`                                                                                                                                                                  |
| PATCH  | `/tickets/:ticketId`                   | `{ title?, description?, priority?, tags?: ref[], assignee?: string \| null, dueDate?, agentEffort?: string \| null, pullRequest?: url \| null, ifVersion? }` | `Ticket`                                                                                                                                                                  |
| DELETE | `/tickets/:ticketId`                   |                                                                                                                                                               | `204`                                                                                                                                                                     |
| POST   | `/tickets/:ticketId/move`              | `{ column: ref, position?, ifVersion?, force? }`                                                                                                              | `Ticket` (appended when `position` is omitted)                                                                                                                            |
| POST   | `/tickets/:ticketId/claim`             | `{ agent, moveTo?: ref, ifVersion? }`                                                                                                                         | `Ticket`; `409` if claimed by someone else (idempotent for the same agent)                                                                                                |
| POST   | `/tickets/:ticketId/release`           | `{ agent, moveTo?: ref, force? }`                                                                                                                             | `Ticket`; `409` if claimed by someone else unless `force`                                                                                                                 |
| POST   | `/boards/:boardId/tickets/claim-next`  | `{ agent, column: ref, tags?: ref[], moveTo?: ref }`                                                                                                          | `Ticket`: highest priority, then earliest due date, then board order, among unassigned tickets in `column` having all `tags`                                              |
| POST   | `/tickets/:ticketId/review`            | `{ agent, pullRequest: url, comment?: markdown, ifVersion? }`                                                                                                 | `Ticket`: links the pull request, assigns `agent`, posts `comment`, moves to the review column; `409` if claimed by someone else, `400` if the board has no review column |
| POST   | `/tickets/:ticketId/pull-request/sync` |                                                                                                                                                               | `Ticket` after checking its pull request on GitHub now                                                                                                                    |
| GET    | `/tickets/:ticketId/activity`          |                                                                                                                                                               | `Activity[]` (oldest first)                                                                                                                                               |
| POST   | `/tickets/:ticketId/comments`          | `{ body }` (markdown)                                                                                                                                         | `Activity`                                                                                                                                                                |

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
  totals: { boards; open; working; review; completed; activeAgents; workedMs } // all numbers
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
      pullRequest: { url; state } | null
    }[]
    workedMs: number // within the range; ongoing work counts up to generatedAt
    completed: number // tickets that reached the done column while assigned to it, within the range
    actions: number // activity entries it authored within the range
    lastActiveAt: string | null
    agentOf: string[] // ids of boards whose host agent runs under this name
  }[]
  hiddenAgents: string[] // names cleared from `agents` (see below)
  boards: { id; name; agentEnabled; agentName; open; working; review; completed; events; lastActivityAt }[]
  events: { at: string; kind: 'created' | 'completed' | 'comment' | 'update'; actor: string; boardId: string }[]
  sessions: { agent; ticketId; boardId; start: string; end: string | null }[] // clipped to the range
  completions: { ticketId; boardId; at: string; cycleMs: number | null; reviewMs: number | null }[] // oldest first
  recent: (Activity & { ticket: { number; title; boardId; boardName } })[] // latest 30, newest first
}
```

Agents are everyone holding a ticket that isn't done, everyone who worked within the range, and the host agent
of every board that has it switched on. A ticket is being **worked** while it is assigned and outside the board's
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
after every committed change (omit `board` to receive all boards), plus periodic `ping` events.

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
