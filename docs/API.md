# ultrakanban API

JSON over HTTP. Base URL: `http://127.0.0.1:4317/api` (in development the Vite dev server also proxies `/api`).

- Send `Content-Type: application/json` for request bodies.
- Send `X-Actor: <your-name>` on writes so the activity log shows who did what.
- Every write is a single atomic SQLite transaction: it either fully applies or not at all.
- Errors look like `{ "error": { "code": "...", "message": "...", "details": ... } }`.
  - `400 validation_error` / `bad_request` - fix the request.
  - `404 not_found` - unknown board/column/tag/ticket or route.
  - `404 no_ticket_available` - `claim-next` found nothing to claim.
  - `429 usage_reserve_reached` - `claim-next` and `POST /tickets/:id/claim` hand out no new tickets while the week's or the current session's
    Claude usage is at its usage reserve, or a limit is used up and agents may not spend usage credits (see
    [Claude usage](#claude-usage)); `details` has the `limit` and its `reservePercent`. The `Retry-After` header says how many seconds until the limit resets (300 if that is unknown).
  - `409 blocked` - `POST /tickets/:id/claim` on a ticket `claim-next` would skip (tagged `blocked`, waiting for an
    unfinished ticket, or with unfinished sub-tickets). A ticket the agent already holds can still be claimed by it.
  - `409 already_claimed` / `claimed_by_other` - someone else holds the ticket (`details` has its current `version`, `assignee` and `columnId`).
  - `409 version_conflict` - `ifVersion` did not match (`details` has its current `version`, `assignee` and `columnId`).
  - `409 tag_exists` - tag names are unique per board (case-insensitive).
  - `409 pull_request_not_merged` - the board's done column only accepts tickets whose pull request is merged.
  - `409 merge_in_progress` - the board's pull requests are already being merged.
  - `409 awaiting_approval` - the ticket's plan waits for a person's approval (see [Plans and approval](#plans-and-approval)).
  - `409 cannot_merge` - the ticket's pull request can't be merged now (draft, conflicts, builds on another in review).
  - `413 payload_too_large` / `415 unsupported_media_type` - attachments must be PNG, JPEG, GIF, WebP, MP4 or WebM, up to 25 MB.

Columns, tags and epics can be referenced **by id or by name** (an epic's title) (case-insensitive) wherever a request field says `ref`.
Unknown tag names are created automatically when creating or updating tickets.

## Recommended agent workflow

**Name yourself after what you run on.** An agent's name (the `agent` field and the `X-Actor` header) is
`<agent>/<model>/<effort>`, e.g. `claude/claude-opus-5-5/high`: the tool or board agent, then the exact model and
effort level. Use the name you were given if there is one; otherwise build it this way and never invent a new one,
so the board and its history show which model and effort did each piece of work. The board's own agent names its
runs like this from the board settings (`agentWorkerName` in `shared/domain.ts`).
Agents other than Claude Code do the same, with their own effort levels (`codex/gpt-5.1-codex/minimal`) or `default`
for a model that has none (`gemini/gemini-2.5-pro/default`). The model is everything between the first and the last
`/`, so it can have slashes of its own (`opencode/openrouter/qwen/qwen3-coder/default`) and Ollama tags
(`opencode/qwen3-coder:30b/default`).

1. `GET /api/boards` and pick a board. `GET /api/boards/:boardId` shows its columns, tags, tickets and workflow
   (`board.reviewColumnId`, `board.doneColumnId`). Read `board.description`: it says what the board is for and holds
   conventions for every ticket on it, which agents follow unless a ticket says otherwise. The agent loop puts it in
   each run's prompt.
2. Claim work atomically: `POST /api/boards/:boardId/tickets/claim-next` with
   `{ "agent": "claude/claude-opus-5-5/high", "column": "Todo", "moveTo": "In progress" }`.
   Only one agent can ever win a given ticket. Repeat on `404 no_ticket_available` later.
   `claim-next` skips blocked tickets: those tagged `blocked`, and those whose description says they wait for another
   ticket of the board (`blocked by #12`, `blocked on #12`, `depends on #3 and #4`, `waiting on #7`) until that ticket is in the
   done column (the board's last column if it has none) or its pull request is merged. It also skips tickets whose
   sub-tickets aren't all finished (see [Sub-tickets](#sub-tickets)). While the week's or the current session's Claude
   usage is at its usage reserve, it claims nothing and answers `429 usage_reserve_reached` (see
   [Claude usage](#claude-usage)).
   Or claim a specific ticket: `POST /api/tickets/:ticketId/claim`, which applies the same checks (`409 blocked`,
   `429 usage_reserve_reached`) unless the agent already holds the ticket.
3. Read the ticket's comments (`GET /api/tickets/:ticketId/activity`) before starting: they may be newer than
   the description. Report progress and decisions with `POST /api/tickets/:ticketId/comments`.
   If the description has a checklist (`- [ ] step`), check off each step as soon as you finish it with
   `POST /api/tickets/:ticketId/checklist/:index` rather than rewriting the description, not all at once before
   submitting: people follow the ticket's progress by it. Check off only what you did; leave a step you skipped or that
   doesn't apply unchecked and say why when you submit (auto-merge waits until every step is checked).
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
  the token set on the Setup page (see [Setup](#setup)), `GITHUB_TOKEN`/`GH_TOKEN` or the `gh` CLI login, in that order.
  `GET /api/github` returns `{ "auth": "board" | "env" | "gh" | null }`.
- For an open or draft pull request it also reads the checks of its head commit: check runs (GitHub Actions and other
  GitHub apps; the latest run of each name) and commit statuses (older CI integrations) together, as `checks` and
  `failingChecks` (see `PullRequest`), counting them the way the agent loop does (`scripts/agent-loop/ci.sh`). Why the
  first 3 failing check runs failed (their annotations, or their output's title and summary) is only read again when
  the head commit or its set of failing checks changes, to spare GitHub's rate limit.
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
  to merge and no other run is going. Each round also records why each pull request in review isn't merged yet, as
  the ticket's `autoMergeWait` (shown on its card and in its pull request field): "Still a draft", "Merge
  conflicts", "2 checklist items unchecked", "Waiting for checks", "Checks failing: lint, test", "Branch protection
  blocks it, e.g. it needs an approving review", "Waits for #41 to merge first", and so on. A merge GitHub turns down,
  or a round that can't run (no GitHub token, say), is recorded the same way with `failed: true` ("Merging failed:
  …"), and stays until the pull request merges or waits for something else, so a merge that keeps failing shows.
- **Ignoring billing failures:** with the board's `ignoreBillingFailures` on as well, auto-merge also merges a pull
  request whose only failing checks failed because of billing: their excerpt mentions billing, a spending limit,
  failed payments, a locked account or a used-up minutes quota, as GitHub Actions jobs that weren't started say. It
  reads the head commit's checks again first, and waits while any is still running or failed for another reason.
  GitHub's `mergeable_state` may then be `unstable` or `blocked`; when branch protection still refuses the merge (it
  requires those checks or a review, and the token can't bypass it), that shows as "Merging failed: …". The `ready`
  notification follows the same rule.
- Merged tickets move to the done column right away. Merging needs a GitHub token with write access (`400` without
  one).
- **Deleting branches:** with the board's `deleteMergedBranches` on, the server deletes a pull request's branch on
  GitHub once it finds the pull request merged, whether the board merged it or someone did on GitHub. It first moves
  the open pull requests based on that branch to the merged pull request's base, so they stay open. It keeps the
  branch when it is in a fork, is the repository's default branch, or points at a commit other than the merged head.

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
`wake` event (see [Live updates](#live-updates)) so the board's idle agent loops look for work now: its loops that
only fix conflicts (`agentConflictConcurrency`) and those that work tickets fix them side by side. It returns
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
  agentDocker: boolean | null // the board's agent works it in a Docker container (the board's when null)
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
  jevPick: { model; effort; confidence: number | null } | null // Jev's pick, when it was claimed at it (shown as a "Jev 0.82" badge)
  movedAt: string // when it entered its current column
  archived: boolean // in the done column for longer than the board's archiveDoneDays (see Boards)
  // Why the board's auto-merge hasn't merged its pull request yet, as its latest round found (see Auto-merge): only
  // while the board has autoMerge on, the ticket is in the review column and the pull request is open; null when ready.
  // failed: a merge attempt (or the round itself) failed, rather than the pull request not being ready
  autoMergeWait: { reason: string; failed: boolean; since: string } | null
  parentId: string | null // the ticket it is a sub-ticket of (see Sub-tickets)
  subtickets: { done: number; total: number } | null // its finished sub-tickets out of all but cancelled ones; null without any
  epicId: string | null // the epic it belongs to (see Epics)
  createdAt: string
  updatedAt: string
}

interface Epic {
  id: string
  boardId: string
  title: string // unique on its board, case-insensitive
  description: string // markdown
  color: Color
  progress: { done: number; total: number } // its finished tickets out of all but cancelled ones
  done: boolean // it has tickets and they are all finished
  createdAt: string
  updatedAt: string
}

interface AgentRun {
  startedAt: string // its first heartbeat
  seenAt: string // its latest heartbeat
  step: string | null // what it is doing, as its agent last said
  tokens: number | null // tokens it has used so far (input, output and cache), as its agent last said
  stopRequested: { at: string; by: string } | null // when someone asked it to stop (POST /tickets/:id/stop) and who, until it ends
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
  // Combined status of its head commit's check runs (GitHub Actions, other apps) and commit statuses (older CI): failing
  // once any didn't pass, else pending while any runs, else passing; null when it has none, or isn't open or draft
  checks: 'pending' | 'passing' | 'failing' | null
  // The checks that didn't pass, by name (at most 20; empty unless checks is failing). conclusion is the check run's
  // (failure, timed_out, startup_failure, action_required) or the commit status's state (failure, error); excerpt says
  // why, from the annotations or output of the first 3 failing check runs (of all of them while each one's says it
  // failed for billing, see ignoreBillingFailures), or a commit status's description
  failingChecks: { name: string; conclusion: string; url: string | null; excerpt: string | null }[]
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
  agentMaxTurns: number | null // most turns one run may take (claude's --max-turns), 1-10000 (no limit when null)
  agentConflictConcurrency: number | null // more runs that only fix merge conflicts, 0-8, each in a worktree (2 when null)
  agentBacklog: boolean // it also takes tickets from the Backlog column once Todo has none
  agentAllSkills: boolean // its runs load every skill, not only the ultrakanban skill
  agentDocker: boolean // its runs go in Docker containers rather than directly on the machine
  autoMerge: boolean // the server merges pull requests in review once they are ready (see Pull request workflow)
  ignoreBillingFailures: boolean // auto-merge ignores checks that failed only because of billing (see Pull request workflow)
  deleteMergedBranches: boolean // the server deletes pull requests' branches once they are merged (see Pull request workflow)
  archiveDoneDays: number | null // days in the done column after which tickets are archived, 1-3650 (never when null)
  approvalSize: 'S' | 'M' | 'L' | null // smallest estimate at which the agent waits for approval of its plan (never when null)
  notifyUrl: string | null // where to notify people when a ticket needs them: ntfy, Discord or webhook URL (see Boards)
  agentCleanupRequestedAt: string | null // when someone last asked its agent to clear its build output (see Disk usage)
  jevEnabled: boolean // the board routes tickets with Jev (see [Routing](#routing)); only settable with a TypeSafe key
  jevModels: string[] | null // models Jev may pick from; all when null
  jevThreshold: number | null // smallest confidence at which Jev's pick is used (0.7 when null)
  jevOnlyLower: boolean // Jev may only pick a cheaper setting than the board's default
  jevMode: 'dry-run' | 'on' | null // dry-run records Jev's pick only; set to dry-run when Jev is first switched on
  ticketCount: number // open tickets: all but those in the done column or the one named Cancelled (any case)
  waitingCount: number // open tickets whose agent waits for a person: approval of its plan, or an answer to its comment
  reviewCount: number // tickets in the review column
  backlogCount: number // tickets in the column named Backlog (any case)
  createdAt: string
  updatedAt: string
}
```

## Boards

| Method | Path                           | Body / query                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Returns                                                   |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| GET    | `/boards`                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `BoardSummary[]` (most recently updated first)            |
| POST   | `/boards`                      | `{ name, description?, columns?: string[], reviewColumn?: ref, doneColumn?: ref, githubRepo?, agentEnabled?, agentName?, agentModel?, agentEffort?, agentConcurrency?, agentMaxTurns?, agentConflictConcurrency?, agentBacklog?, agentAllSkills?, agentDocker?, autoMerge?, ignoreBillingFailures?, deleteMergedBranches?, archiveDoneDays?, notifyUrl?, approvalSize? }`                                                                                                                                                                                                                                                                                 | `BoardSummary`                                            |
| GET    | `/boards/:boardId`             | `?archived=true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `{ board, columns, tags, epics, tickets, archivedCount }` |
| PATCH  | `/boards/:boardId`             | `{ name?, description?, reviewColumn?: ref \| null, doneColumn?: ref \| null, githubRepo?: string \| null, agentEnabled?: boolean, agentName?: string \| null, agentModel?: string \| null, agentEffort?: 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max' \| null, agentConcurrency?: number \| null, agentMaxTurns?: number \| null, agentConflictConcurrency?: number \| null, agentBacklog?: boolean, agentAllSkills?: boolean, agentDocker?: boolean, autoMerge?: boolean, ignoreBillingFailures?: boolean, deleteMergedBranches?: boolean, archiveDoneDays?: number \| null, notifyUrl?: string \| null, approvalSize?: 'S' \| 'M' \| 'L' \| null }` | `BoardSummary`                                            |
| POST   | `/boards/:boardId/github-repo` | `{ name, owner?, description?, private?: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `BoardSummary` (201)                                      |
| DELETE | `/boards/:boardId`             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `204`                                                     |
| GET    | `/boards/:boardId/export`      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | portable board JSON                                       |
| POST   | `/boards/import`               | portable board JSON                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `BoardSummary`                                            |

`POST /boards/:boardId/github-repo` creates a repository on GitHub with the server's login and sets it as the board's
`githubRepo`. It is created under `owner` (a user or organization; the signed-in user when omitted), private unless
`private` is `false`, and with a README so it has a default branch for agents to clone and branch from. It fails with
`400 github_unauthenticated` when the server isn't signed in to GitHub, `400 github_error` when GitHub turns the
request down (e.g. the name is taken, or the token can't create repositories there; the message says why) and
`502 github_error` when GitHub can't be reached. The token needs the `repo` scope (fine-grained tokens:
Administration write), and `read:org` plus access to the organization to create one in an organization.

`agentEnabled` can only be switched on once `githubRepo` is set (`400` otherwise). It is read by
`scripts/agent-supervisor.sh`, which runs on the host and keeps one agent loop per enabled board; see `docs/agents.md`.
The loop runs Claude Code with `agentModel` and `agentEffort` and claims tickets as
`<agentName>/<agentModel>/<agentEffort>`, e.g. `claude/opus/medium` with nothing set. A ticket's own `agentModel`
and `agentEffort` override the board's for that ticket: the loop runs it with them and under that name.
`agentMaxTurns` caps the turns one run of the agent may take: the loop passes it to `claude` as `--max-turns`, so a runaway
run stops there rather than at the ticket timeout. Without it a run has no turn limit.
`agentConcurrency` is how many tickets the agent works at once: the host runs that many loops, each in its own git
worktree of the board's clone, and never two on the same ticket. `agentConflictConcurrency` is how many more loops
it runs, each in a worktree of its own too, that claim nothing and only fix the merge conflicts of the pull requests in
the review column, so the conflicts that merging one causes in the others are fixed side by side. With `agentBacklog` on, the agent takes new tickets
from the `Backlog` column once the `Todo` column has none left and the `In progress` column holds fewer than
`agentConcurrency` tickets (the loop's `TODO_COLUMN`, `BACKLOG_COLUMN` and `IN_PROGRESS_COLUMN` name them). With `agentAllSkills` off, runs only get the ultrakanban skill, unless the repository has skills of its own.
With `agentDocker` on, the loop runs Claude Code in a Docker container that only sees the ticket's checkout and the
agent's Claude, GitHub and git settings, instead of directly on the host; a ticket's own `agentDocker` (`true` or
`false`) overrides the board's. The loop's `DOCKER_IMAGE` and `DOCKER_ARGS` choose the image and its limits.

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
- `ready`: a pull request in the review column is ready to merge (open, not a draft, no conflicts, every check passed
  or, with `ignoreBillingFailures`, failed only for billing, every checklist item checked), checked with the pull request sync. Only on boards without `autoMerge`, which merge
  it instead.

Each is sent once: once per comment, answer or pull request commit. An ntfy topic (on `ntfy.sh`, or a server with `ntfy` as a part of its host
name, e.g. `ntfy.example.com`) gets the message with its title and link; a Discord webhook gets a Discord message; any other URL
gets a JSON `POST` of `{ kind, boardId, boardName, ticketId, ticketNumber, ticketTitle, title, message, url }`. `url`
links to the ticket when the server's `ULTRAKANBAN_URL` is set, otherwise to its pull request, if any.

## Columns and tags

| Method | Path                              | Body / query                                                                                         | Returns                                        |
| ------ | --------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| POST   | `/boards/:boardId/columns`        | `{ name, color?, wipLimit?: number \| null, position? }`                                             | `Column`                                       |
| PATCH  | `/columns/:columnId`              | `{ name?, color?, wipLimit? }`                                                                       | `Column`                                       |
| POST   | `/columns/:columnId/move`         | `{ position }`                                                                                       | `Column`                                       |
| DELETE | `/columns/:columnId`              | `?moveTicketsTo=ref` or `?deleteTickets=true` (`409 column_not_empty` if it has tickets and neither) | `204`                                          |
| GET    | `/columns/:columnId/idle-tickets` |                                                                                                      | `Ticket[]` idle in the column (see below)      |
| POST   | `/columns/:columnId/release-idle` | `{ moveTo: ref }`                                                                                    | `Ticket[]` it unassigned and moved to `moveTo` |
| POST   | `/boards/:boardId/tags`           | `{ name, color? }`                                                                                   | `Tag`                                          |
| PATCH  | `/tags/:tagId`                    | `{ name?, color? }`                                                                                  | `Tag`                                          |
| DELETE | `/tags/:tagId`                    |                                                                                                      | `204`                                          |

A ticket is idle when no agent has sent a heartbeat for it (`POST /tickets/:ticketId/heartbeat`) and nothing has
happened on it (no activity) for 10 minutes. `scripts/agent-loop.sh` sends one every `TICKET_CHECK_SECONDS` while a
run is working the ticket; the board offers to move a working column's idle tickets back to its todo column, e.g.
tickets whose agent stopped or crashed.

Heartbeats also make up the ticket's `run`, which its card shows: a heartbeat starts a run unless one is going on,
and can say what the run is doing (`step`) and how many tokens it has used so far (`tokens`); a heartbeat without them
keeps the run's. `scripts/agent-loop.sh` sends the run's latest tool call as its step (e.g. `Bash: npm test`) when it
changes, checked every `RUN_STEP_SECONDS`, and its tokens so far with every heartbeat, so a runaway run shows while
it goes on. The run ends with `DELETE /tickets/:ticketId/heartbeat`, or after 10 minutes without a heartbeat.
Cards show a run as stalled after 3 minutes without one.

### Stopping a run

`POST /tickets/:ticketId/stop` (no body; the Stop button on a running ticket's card and in the ticket) asks the run
working the ticket to stop, e.g. to give its agent new instructions. It sets the run's `stopRequested` to when and who
(`X-Actor`), logs a `stopped` activity entry (`data: { step }`, what the run was doing), sends a `wake` event (see
[Live updates](#live-updates)) and returns the `Ticket`; `409 no_run` when no run is going. Asking again before the
run stops changes nothing. The request lasts until the run ends (`DELETE /tickets/:ticketId/heartbeat`), and a new run
starts without one. `scripts/agent-loop.sh` sees it at its next check of the ticket (every `TICKET_CHECK_SECONDS`),
stops the run without losing its session or work, and resumes it once there is new feedback, such as a comment.
Agents of your own that send heartbeats should do the same: stop when their ticket's `run.stopRequested` is set,
and end the run.

## Tickets

| Method | Path                                   | Body / query                                                                                                                                                                                                                                                                                                 | Returns                                                                                                                                                                                                                                                                                                              |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/boards/:boardId/tickets`             | `?column=ref&assignee=name&unassigned=true&tag=ref&priority=high&epic=ref&q=text` (`epic=none`: in no epic) (`tag`, `priority` repeatable)                                                                                                                                                                   | `Ticket[]` in board order                                                                                                                                                                                                                                                                                            |
| GET    | `/boards/:boardId/tickets/:number`     |                                                                                                                                                                                                                                                                                                              | `Ticket`                                                                                                                                                                                                                                                                                                             |
| POST   | `/boards/:boardId/tickets`             | `{ title, description?, column?: ref, priority?, tags?: ref[], assignee?, dueDate?, agentEffort?, agentModel?, agentDocker?, pullRequest?: url, parent?: ref, epic?: ref, position?, force? }`                                                                                                               | `Ticket` (defaults to the first column, appended)                                                                                                                                                                                                                                                                    |
| GET    | `/tickets/:ticketId`                   |                                                                                                                                                                                                                                                                                                              | `Ticket`                                                                                                                                                                                                                                                                                                             |
| GET    | `/tickets/:ticketId/route`             |                                                                                                                                                                                                                                                                                                              | `{ routed: RoutedSetting \| null }`: the setting to work the ticket at on a board whose Jev mode is `on`, for runs on feedback; asks Jev only when the ticket changed since it last picked. `null` on other boards (see [Routing](#routing))                                                                         |
| PATCH  | `/tickets/:ticketId`                   | `{ title?, description?, priority?, tags?: ref[], assignee?: string \| null, dueDate?, agentEffort?: 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max' \| null, agentModel?: string \| null, agentDocker?: boolean \| null, pullRequest?: url \| null, parent?: ref \| null, epic?: ref \| null, ifVersion? }` | `Ticket`                                                                                                                                                                                                                                                                                                             |
| DELETE | `/tickets/:ticketId`                   |                                                                                                                                                                                                                                                                                                              | `204`                                                                                                                                                                                                                                                                                                                |
| POST   | `/tickets/:ticketId/move`              | `{ column: ref, position?, ifVersion?, force? }`                                                                                                                                                                                                                                                             | `Ticket` (appended when `position` is omitted)                                                                                                                                                                                                                                                                       |
| POST   | `/tickets/:ticketId/claim`             | `{ agent, moveTo?: ref, ifVersion? }`                                                                                                                                                                                                                                                                        | `Ticket`, with `routed` on a board whose Jev mode is `on` (see [Routing](#routing)); `409` if claimed by someone else (idempotent for the same agent), `409 blocked` if `claim-next` would skip it, `429 usage_reserve_reached` as for `claim-next`                                                                  |
| POST   | `/tickets/:ticketId/release`           | `{ agent, moveTo?: ref, force? }`                                                                                                                                                                                                                                                                            | `Ticket`; `409` if claimed by someone else unless `force`                                                                                                                                                                                                                                                            |
| POST   | `/tickets/:ticketId/heartbeat`         | `{ step?, tokens? }` (optional)                                                                                                                                                                                                                                                                              | `204`; says an agent is working on the ticket right now (not a change: nothing is logged)                                                                                                                                                                                                                            |
| DELETE | `/tickets/:ticketId/heartbeat`         |                                                                                                                                                                                                                                                                                                              | `204`; says the agent's run on the ticket has ended                                                                                                                                                                                                                                                                  |
| POST   | `/tickets/:ticketId/stop`              |                                                                                                                                                                                                                                                                                                              | `Ticket` with `run.stopRequested` set: asks the run working it to stop (see Stopping a run); `409 no_run` without one                                                                                                                                                                                                |
| POST   | `/boards/:boardId/tickets/bulk`        | `{ tickets: ref[], moveTo?: ref, force?, priority?, addTags?: ref[], removeTags?: ref[], epic?: ref \| null, agentModel?: string \| null, agentEffort?: string \| null }` or `{ tickets: ref[], delete: true }`                                                                                              | `{ tickets: Ticket[] }`: the same change to several tickets, all or nothing (e.g. `409` if one can't enter the done column, unless `force`); moved tickets are appended in the order given; `tickets: []` when deleted                                                                                               |
| POST   | `/boards/:boardId/tickets/claim-next`  | `{ agent, column: ref, tags?: ref[], moveTo?: ref }`                                                                                                                                                                                                                                                         | `Ticket` (with `routed` on a board whose Jev mode is `on`, see [Routing](#routing)): highest priority, then earliest due date, then board order, among unassigned, unblocked tickets in `column` having all `tags` (see below)                                                                                       |
| POST   | `/tickets/:ticketId/plan`              | `{ agent, estimate: 'S' \| 'M' \| 'L', plan: markdown }`                                                                                                                                                                                                                                                     | `Ticket`: posts the plan, sets `estimate`, and holds the ticket for approval (`approval: 'pending'`) when the board's `approvalSize` asks for it; `409` if claimed by someone else                                                                                                                                   |
| POST   | `/tickets/:ticketId/approve`           | `{ ifVersion? }` (optional)                                                                                                                                                                                                                                                                                  | `Ticket` with `approval: 'approved'`; `409 not_awaiting_approval` if its plan doesn't wait for approval, `409 own_plan` when sent by its assignee                                                                                                                                                                    |
| POST   | `/tickets/:ticketId/review`            | `{ agent, pullRequest?: url, comment?: markdown, ifVersion? }`                                                                                                                                                                                                                                               | `Ticket`: links the pull request, assigns `agent`, posts `comment`, moves to the review column; `409` if claimed by someone else, `400` if the board has no review column, or without `pullRequest` unless the ticket is a `question` answered in `comment`, its sub-tickets are all finished, or it already has one |
| POST   | `/tickets/:ticketId/pull-request/sync` |                                                                                                                                                                                                                                                                                                              | `Ticket` after checking its pull request on GitHub now                                                                                                                                                                                                                                                               |
| GET    | `/tickets/:ticketId/checklist`         |                                                                                                                                                                                                                                                                                                              | `ChecklistItem[]`: the description's task list items (`- [ ]` / `- [x]`), outside code blocks                                                                                                                                                                                                                        |
| POST   | `/tickets/:ticketId/checklist/:index`  | `{ checked?: boolean, ifVersion? }` (`checked` defaults to `true`)                                                                                                                                                                                                                                           | `Ticket` with the item at `index` (0-based) checked off or unchecked and the rest of the description untouched; `404` if there is no such item                                                                                                                                                                       |
| GET    | `/tickets/:ticketId/activity`          |                                                                                                                                                                                                                                                                                                              | `Activity[]` (oldest first)                                                                                                                                                                                                                                                                                          |
| POST   | `/tickets/:ticketId/comments`          | `{ body, pullRequest?, notify? }` (markdown); `pullRequest: true` also posts it on the ticket's pull request (`data.pullRequestComment` links it); `notify: true` also sends the board's notification                                                                                                        | `Activity`                                                                                                                                                                                                                                                                                                           |
| GET    | `/tickets/:ticketId/children`          |                                                                                                                                                                                                                                                                                                              | `Ticket[]`: its sub-tickets, in board order                                                                                                                                                                                                                                                                          |
| POST   | `/tickets/:ticketId/children`          | same as `POST /boards/:boardId/tickets`, without `parent`                                                                                                                                                                                                                                                    | `Ticket`: a sub-ticket of this one, on its board (`201`)                                                                                                                                                                                                                                                             |

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

### Epics

An epic groups the tickets of a larger piece of work, e.g. a feature that takes several pull requests. It isn't a
ticket: agents never claim it, it has no pull request, and it sits above the board's columns rather than in one. Any
ticket can be in one epic, sub-tickets included.

| Method | Path                     | Body / query                       | Returns                                                 |
| ------ | ------------------------ | ---------------------------------- | ------------------------------------------------------- |
| GET    | `/boards/:boardId/epics` |                                    | `Epic[]`, oldest first                                  |
| POST   | `/boards/:boardId/epics` | `{ title, description?, color? }`  | `Epic` (`201`; `409 epic_exists` if the title is taken) |
| GET    | `/epics/:epicId`         |                                    | `Epic`                                                  |
| PATCH  | `/epics/:epicId`         | `{ title?, description?, color? }` | `Epic`                                                  |
| DELETE | `/epics/:epicId`         |                                    | `204`; its tickets stay, in no epic                     |

- Put a ticket in an epic with `epic` (its id or title) when creating or updating it, or for several at once with
  `POST /boards/:boardId/tickets/bulk`; `"epic": null` takes it out. The bulk endpoint also sets `agentModel`/`agentEffort` on all the tickets (`null` follows the board's setting). An unknown title creates the epic, like tags.
  New sub-tickets join their parent's epic unless `epic` says otherwise.
- `progress` counts its finished tickets (in the done column, the board's last column if it has none, or with a
  merged pull request) out of all of them, leaving out those in a column named `Cancelled`. It is `done` once they
  all are: nobody closes it.
- `GET /boards/:boardId/tickets?epic=ref` lists an epic's tickets.
- **Filing several tickets for one larger feature?** Group them in an epic: create it first
  (`POST /boards/:boardId/epics` with a title and a description of the feature), then pass its title or id as `epic`
  on each ticket. Check `GET /boards/:boardId/epics` for one that fits before creating another.

## Token usage

Agents report the tokens each run used on a ticket, and the [overview](#overview) adds them up per agent, board and
day. `scripts/agent-loop.sh` reports every `claude -p` run it starts that leaves a result (from the result at the end of
its `--output-format stream-json` output, all models the run called, subagents included); other agents can report
theirs the same way. Runs that weren't on a ticket (an assistant
answering a question, say) are reported to the board instead, and count toward the agent's and the board's totals just
the same, with `ticketId: null`. Every ticket carries its runs' totals in `usage`.

A run can also say how its tokens split between the models it called (`models`, one entry per model, from
`claude -p`'s `modelUsage`; the agent loop sends it), so the overview can show token usage by model. The overview
counts a run that doesn't as one of the model in its agent's name (`opus` for `claude/opus/high`, `gpt-5.1-codex`
for `codex/gpt-5.1-codex/minimal`), or of `unknown`. `costUsd` is optional: leave it out when the agent doesn't know
its cost (local models cost nothing), and the totals show no cost rather than $0 until a run reports one. `apiKey`
(default false) says the run went on the agents' API key rather than the Claude plan, so its cost was billed, not
estimated (see [Claude usage](#claude-usage)).

| Method | Path                       | Body                                                                                                                                                                                                        | Returns                                              |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| POST   | `/tickets/:ticketId/usage` | `{ agent, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd?, durationMs?, apiKey?, models?: { model, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd? }[] }` | `TokenUsage` (201)                                   |
| GET    | `/tickets/:ticketId/usage` |                                                                                                                                                                                                             | `TokenUsage[]` (oldest first)                        |
| POST   | `/boards/:boardId/usage`   | same as for a ticket                                                                                                                                                                                        | `TokenUsage` (201) with `ticketId: null`             |
| GET    | `/boards/:boardId/usage`   |                                                                                                                                                                                                             | `TokenUsage[]` (oldest first), on its tickets or not |

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
  costUsd: number | null // estimated cost, if the agent reported one; billed, for a run on the API key
  apiKey: boolean // whether the run went on the agents' API key rather than the Claude plan
  durationMs: number | null
  // The same split by model (e.g. claude-opus-5-5), most tokens first; empty if the agent didn't report it
  models: { model; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; costUsd: number | null }[]
  routing: RunRouting | null // how the run was routed (see below); null for runs on no ticket or at a setting no source picked
  createdAt: string
}

interface RunRouting {
  source: 'ticket' | 'jev' | 'history' | 'default' // where the model and effort the run worked at came from
  confidence: number | null // the source's confidence in it, when it has one (Jev's)
  jev: { model; effort; confidence } | null // Jev's pick when the ticket was claimed, used or not (dry run)
}
```

### Routing

Each claim (`claim` and `claim-next`) records how the ticket is routed: the setting it is worked at and where that came
from (`ticket` when it names its own `agentModel`/`agentEffort`, else the board's `default`), and what the other sources
would have picked: the [history suggestion](#suggested-model-and-effort) when it is built on 3 or more similar tickets,
and, on a board that routes with Jev (`jevEnabled`, see [docs/JEV.md](JEV.md)), Jev's pick and confidence. Jev is asked
before the claim returns, and in `dry-run` mode its pick is only recorded, never used. A Jev request that fails is
left out and never fails the claim. Each Jev request is recorded as a run on the ticket (agent `jev`, model
`jev-1.14.0`, at $0.042 per million input tokens), so its tokens and cost count in the usage too.

In `on` mode the claim also returns the setting to work the ticket at as `routed`, without writing over the ticket's own
`agentModel`/`agentEffort`, and the agent loop works the ticket at it. The first source that has a pick wins:

1. `ticket`: the ticket's own setting (the board's default for the half it leaves out). Jev isn't asked then.
2. `jev`: Jev's pick, when its confidence is at least the board's `jevThreshold`. A pick that drops below the
   board's default to `haiku` or to `low` effort needs more: halfway from the threshold to 1 (0.85 at 0.7). When
   Jev's effort probability is spread over two efforts (within 0.1 of each other), the higher one is taken, or the
   lower one when Jev thinks the ticket is fully specified.
3. `history`: the history suggestion, when it is built on 3 or more similar tickets.
4. `default`: the board's `agentModel` and `agentEffort`.

Jev's and the history suggestion's picks must be among the board's `jevModels`, and with `jevOnlyLower` each is held to
the board's default (its model and its effort each no dearer). Whichever of `jev`, `history` and `default` routes, the
ticket never goes below the setting the board agent's newest run on it worked at, its model and its effort each: a
ticket whose run failed or that came back from review with changes keeps or raises its setting. Jev's pick is kept with a hash of what it was told about
the ticket (title, description with its checklist unchecked, tags, epic, and the models it may pick from), and Jev isn't
asked again until one of those changes: claiming the ticket again, checking off steps or reassigning it doesn't. A
failed or timed-out Jev request (2 s) is never kept: routing goes on to the next source, and the next claim or route
asks again. Runs on feedback get the same setting from `GET /tickets/:ticketId/route`.

`POST /boards/:boardId/jev-suggestion` with `{ title?, description?, tagIds?: id[], epicId?: id | null }` asks Jev on
demand which model (among the board's `jevModels`) and effort a ticket as written needs, for the "Suggest with Jev"
button in the ticket form and properties. It answers `{ model, effort, confidence, probabilities: { model: {name: p},
effort: {name: p}, fullySpecified: p } }` and records nothing. `409 jev_unavailable` without a TypeSafe key, `502
jev_failed` when Jev can't be asked or its answer doesn't fit.

```ts
interface RoutedSetting {
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  source: 'ticket' | 'jev' | 'history' | 'default' // which source won
  confidence: number | null // Jev's confidence, for source "jev"
}
```

Each run's usage then carries its `routing`: the source whose setting the run's `<agent>/<model>/<effort>` name
matches. The [suggestion](#suggested-model-and-effort) and the [overview](#overview) compare the sources by cost per
_finished_ ticket (cost divided by success rate), on the tickets decided since routing was recorded:

- Each source is counted as if it had picked every ticket's setting: Jev when its confidence is at least the board's
  `jevThreshold` (else it falls back to the history suggestion, then the default, as routing would), the history
  suggestion (else the default), and the default.
- A ticket worked at the setting a source picked counts as it went. One worked at another setting counts at the
  board's average for the pick (its cost per decided ticket and its success rate), once the board has decided 3 or
  more tickets at it; until then it is left out of that source (`unmeasured`).
- Costs are in US dollars when every counted run reported one, else in tokens weighted by kind (input 1, output 5,
  cache write 1.25, cache read 0.1: cache reads are cheap but dominate raw totals).
- `verdict` names the cheapest source only once two or more are compared and each has 10 finished tickets.

```ts
interface RoutingComparison {
  unit: 'usd' | 'tokens'
  // Each source that picked a ticket for itself, and the default; cheapest per finished ticket first
  sources: {
    source: 'jev' | 'history' | 'default'
    tickets: number // decided tickets counted
    picked: number // tickets it picked for itself (counted or not); for the rest it fell back to the next source
    worked: number // counted tickets worked at its pick; the rest count at the board's average for the pick
    unmeasured: number // tickets left out: too few decided at its pick
    finished: number // may be fractional: tickets counted at an average count by its success rate
    successRate: number | null
    costUsd: number | null // null unless every counted run reported a cost
    weightedTokens: number
    costPerFinished: number | null // in unit
  }[]
  verdict: 'jev' | 'history' | 'default' | null
  jev: { calls: number; costUsd: number } // what asking Jev cost (not in the sources' costs)
}
```

### Run records

Agents also record what each run on a ticket did and how it ended, so people can see why an agent is stuck without
reading its logs: the ticket's activity shows each run, collapsed to how long it took and how it ended, opening to its
final message and the tool calls it made. `scripts/agent-loop.sh` records every run it starts, whether it finished,
failed, timed out or was killed, from claude's `--output-format stream-json` output (see [Agents](agents.md)). Unlike
token usage, a run is recorded even when it ended without a result.

| Method | Path                      | Body / query                                                                                                                                             | Returns                                       |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| POST   | `/tickets/:ticketId/runs` | `{ agent, outcome, exitCode?, durationMs?, turns?, costUsd?, apiKey?, message?, steps?: { tool, summary?, error? }[], omittedSteps?: { after, count } }` | `RunRecord` (201)                             |
| GET    | `/tickets/:ticketId/runs` | `?limit=20` (1 to 50)                                                                                                                                    | `RunRecord[]` (newest first, at most `limit`) |

Records stay small: `message` is clipped to 4000 characters, `steps` holds at most 150 tool calls (send the first and
last ones of a longer run, and say how many were left out between them with `omittedSteps`), and each ticket keeps its
newest 50 records.

```ts
interface RunRecord {
  id: number
  ticketId: string
  agent: string // who ran, e.g. claude/opus/high
  // finished: exited successfully; failed: exited with an error; timed_out: ran past the loop's TICKET_TIMEOUT;
  // killed: by a signal (exit status 137 is most likely the kernel, out of memory); stopped: the loop stopped it as
  // someone took the ticket away; stop_requested: the loop stopped it as someone asked (POST /tickets/:id/stop; the
  // run is resumed with new feedback); usage_limit: the account ran out of Claude usage (the run is resumed later)
  outcome: 'finished' | 'failed' | 'timed_out' | 'killed' | 'stopped' | 'stop_requested' | 'usage_limit'
  exitCode: number | null
  durationMs: number | null
  turns: number | null // responses of the model
  tokens: number | null // input, output and cache tokens it used
  costUsd: number | null
  apiKey: boolean // whether it went on the agents' API key (its cost billed, not estimated)
  message: string // the final message (markdown), or what the run last said or printed; '' when there was nothing
  // Its tool calls in order (not its subagents'): summary is a short target for people, e.g. a command's first line,
  // a file's path or a search pattern; error says whether the tool reported one
  steps: { tool: string; summary: string; error: boolean }[]
  omittedSteps: { after: number; count: number } | null // count steps left out between steps[after - 1] and steps[after]
  createdAt: string // when it was recorded, as the run ended
}
```

### Suggested model and effort

`GET /boards/:boardId/agent-suggestion?title=text&tag=ref&steps=3&estimate=M` suggests a model and effort for a ticket
about to be created, from how the board's similar tickets went (the new-ticket form shows it). `tag` is repeatable (ids
or names; ones the board doesn't have are ignored), `steps` is how many checklist steps its description has and
`estimate` the size (`S`, `M`, `L`) its agent's plan estimated it at (leave either out when unknown). Routing at claim
time passes the ticket's own.

- **Past tickets** count once they are decided: finished (in the done column or with a merged pull request), or given
  up on (in the cancelled column, or with their pull request closed unmerged). Each counts at the setting of the
  `<agent>/<model>/<effort>` name whose runs used the most tokens on it (weighted by kind, see below), with the cost
  of all its runs. Only tickets
  the board's own agent did most of (names starting with its `agentName`, `claude` by default) count: the suggestion
  sets the model and effort it works the ticket at, and another agent's (Codex on GPT, say) aren't any it can run.
- **Similar** means sharing tags (40%) or title words (40%, stop words left out); a similar number of checklist steps
  (10%) and a similar plan estimate (10%: the same size counts fully, one size apart half) add to that but aren't
  enough alone. A size either ticket lacks is left out of the weighting. The 20 most similar count, each weighted by
  its similarity.
- **Tokens are weighted by kind** about as Claude prices them, relative to uncached input: output 5, cache writes
  1.25, cache reads 0.1. Cache reads make up most of a run's raw total.
- **The suggestion** is the setting that costs least per _finished_ ticket (its average cost over its success rate, so
  each finished ticket also pays for the ones given up on; by weighted tokens when runs reported no cost) among those
  whose weighted success rate is within 0.2 of the best one's. Only settings at least 2 similar decided tickets were
  worked at can be suggested; the others still show in `options`. It is `null` when none of those finished a similar
  ticket.

```ts
interface AgentSuggestion {
  suggestion: AgentSettingStats | null
  options: AgentSettingStats[] // every setting similar tickets were worked at, the suggestion first
  routing: RoutingComparison // how the board's routing sources compare (see Routing)
}

interface AgentSettingStats {
  model: string // e.g. sonnet
  effort: string // e.g. medium
  tickets: number // similar decided tickets worked at it
  finished: number // how many of them were finished
  successRate: number // finished share, weighted by similarity (0 to 1)
  costUsd: number | null // average cost per ticket; null when none reported one
  costPerFinishedUsd: number | null // costUsd / successRate; null without a cost or a finished ticket
  tokens: number // average tokens per ticket
  weightedTokens: number // average tokens per ticket, weighted by kind
  weightedTokensPerFinished: number | null // weightedTokens / successRate; null without a finished ticket
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
  boards: {
    id
    name
    agentEnabled
    agentName
    open
    working
    review
    completed
    events
    tokens
    costUsd: number | null // estimated cost of the runs on it within the range; null when none reported one
    lastActivityAt
    // Bytes of its attachments, and of its agent's folder as the agent supervisor last measured it (null if it hasn't):
    // the clone, the worktrees of parallel runs, and the rest (loop state, runs' scratch files)
    disk: { attachments: number; agent: { repo; worktrees; state; measuredAt: string } | null }
  }[]
  // When the supervisor last measured the agent folders, and the bytes the folders of deleted boards take
  disk: { measuredAt: string | null; deletedBoards: number }
  events: { at: string; kind: 'created' | 'completed' | 'comment' | 'update'; actor: string; boardId: string }[]
  sessions: { agent; ticketId; boardId; start: string; end: string | null }[] // clipped to the range
  // Oldest first; costUsd is what all the ticket's runs cost, whenever they ran (null when none reported a cost)
  completions: {
    ticketId
    boardId
    at: string
    cycleMs: number | null
    reviewMs: number | null
    costUsd: number | null
  }[]
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
  routing: RoutingComparison // routing sources compared on every board, over all time (see Routing)
  // Every board's decided tickets by the model and effort that did most of their work (any agent), over all time,
  // most tickets first: the suggestion's figures with every ticket counting fully
  settings: { model; effort; tickets; finished; successRate: number; costUsd: number | null; tokens: number }[]
}

// Token usage added up over runs; costUsd sums the runs that reported a cost (null when none did).
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

## Updating ultrakanban

The app can't update itself from its container; the updater does it when asked: the agent supervisor
(`scripts/agent-supervisor.sh`) on a Linux host, or the updater container (`deploy/updater.sh`, compose profile
`updater`) on Windows and macOS. Below, "the supervisor" is either. `GET /system/update` returns the state:

```ts
{
  state: 'idle' | 'requested' | 'running' | 'done' | 'failed'
  requestedAt: string | null, requestedBy: string | null
  finishedAt: string | null // when it last finished, done or failed
  message: string | null // the new version, or why it failed
  updaterSeenAt: string | null // when the supervisor last checked in; null if it never has
  version: string | null // the checkout's commit, as "<short sha> <subject>"
  behind: number | null // commits its default branch is behind origin, as of the supervisor's last fetch
  ahead: number | null // its commits that aren't on origin: the update keeps them on a backup branch
  commit: string | null // the checkout's full commit sha
  runningCommit: string | null // the commit the running board was built from (ULTRAKANBAN_COMMIT); null if unknown
}
```

`POST /system/update` (202, no body) asks for an update: the supervisor moves its checkout to origin's default branch
(`git checkout -B main origin/main`, whatever it had checked out), rebuilds and restarts the board, and reports how it
went. It keeps the checkout's local changes in a git stash and its own commits on a backup branch, and its message says
where. Once the board answers
again, the supervisor checks it runs the commit it built (`runningCommit`), and fails the update if not. `409 update_in_progress` while one is requested or running.
`DELETE /system/update` withdraws a request the supervisor hasn't taken yet (`409 update_running` once it has).

The supervisor reports with `POST /system/update/status` and `{ state?, message?, version?, behind?, ahead?, commit? }`: without
`state` it only checks in; `running` takes the request (`409 update_not_requested` if there is none), `done` and
`failed` finish it.

## Claude usage

How much of the Claude plan's usage limits is used, as the agent supervisor last read it on the host with its claude
login (from Claude's usage endpoint, what `/usage` in claude shows). `GET /system/claude-usage` returns:

```ts
{
  reportedAt: string | null // when the supervisor last reported; null if it never has
  plan: string | null // the subscription, e.g. "pro" or "max"
  limitsAt: string | null // when the limits were read; older than reportedAt after a report with only an error
  limits: Array<{ label: string; percent: number; resetsAt: string | null }> // e.g. "Current session", "Week, all models"
  // the money the account can spend on usage besides its limits, amounts in `currency` units, limit and remaining null
  // when unknown: kind "grant" ("Credit grant", dollars granted to the plan) or "usage" ("Usage credits", what claude.ai
  // calls extra usage: they cover usage once a limit is reached, while `enabled`). Never API credits, the Claude Console
  // balance API keys spend: the claude login can't read it
  credits: Array<{
    kind: 'grant' | 'usage'
    label: string
    enabled: boolean // always true for a grant; usage credits are listed when off too
    currency: string
    used: number
    limit: number | null
    remaining: number | null
    resetsAt: string | null
  }>
  error: string | null // why the last report has no usage, e.g. no claude login on the host
  // the usage reserve, 1-100 each (see below), null when off; usageCredits: whether agents go on past a used-up limit
  reserve: { week: number | null; session: number | null; usageCredits: boolean }
  // what agents do once usage runs out: wait, or go on on their API key (see below)
  apiKey: {
    enabled: boolean // go on on the key rather than wait
    available: boolean // the agents last checked in with a key (AGENT_API_KEY); never the key itself
    runBudgetUsd: number // most a run on the key may spend (claude -p --max-budget-usd); default 5
    monthlyBudgetUsd: number | null // most runs on the key may spend in a calendar month (UTC); null for no cap
    spentThisMonthUsd: number // what runs on the key reported spending this calendar month (UTC)
    usable: boolean // enabled, available and under the monthly cap
  }
  reserveReached: { label: string; percent: number; resetsAt: string | null } | null // the limit holding agents back now
}
```

The supervisor reports with `POST /system/claude-usage` and `{ plan?, usage?, error? }`: `usage` is the usage
endpoint's answer as it is (the board picks the limits and credits out of it), `error` says why it couldn't get one. A report
without `usage` keeps the last limits, credits and their `limitsAt`, so one failed read doesn't lift the usage reserve.

**The usage reserve** keeps some of the week, of the current session or both for people's own Claude sessions. It is
one setting for the whole Claude account, not per board: `PUT /system/claude-usage/reserve` with
`{ "week": 80, "session": 90, "usageCredits": false }` (each a whole percent, 1-100, or `null` for off; one left out
stays as it is) answers with the usage above. Once a weekly limit (`Week, all models` or a per-model one such as `Week, Opus`) is at or over
`week`, or the current session at or over `session`, `claim-next` hands out no new tickets and answers
`429 usage_reserve_reached`, with the limit and its reserve in `details`. Unless `usageCredits` is true, a limit at 100%
does the same without a reserve (`reservePercent` is then `null`), so agents don't run on the account's usage credits
once a limit is used up (by default they don't); `reserveReached` says which limit it is (of
several, the one that resets last, as claiming starts again only once all of them have). It only goes by fresh
limits, read in the last 30 minutes (`limitsAt`; the supervisor reports every 5), and a limit counts as reset once its
`resetsAt` has passed: stale or missing limits never hold agents back (they fail open), so agents don't stop because
the supervisor did, or because it can't read the usage any more. Only
claiming new tickets stops. Tickets agents already hold still get runs for their feedback, and claiming a given ticket
(`POST /tickets/:ticketId/claim`) still works, so work under way and pull requests in review aren't left halfway;
Claude's own limits stop those runs when the session or the week runs out.

**The agents' API key** lets agents go on once usage runs out instead of waiting for it to reset: a Claude Console key
in the agents' environment (`AGENT_API_KEY`), which the board never sees, and whose runs are billed to its API credits.
`PUT /system/claude-usage/api-key` with `{ "enabled": true, "runBudgetUsd": 5, "monthlyBudgetUsd": 100 }` (dollars,
more than 0; `monthlyBudgetUsd: null` for no monthly cap; one left out stays as it is) answers with the usage above.
While `apiKey.usable`, a limit at 100% no longer holds back `claim-next` (a reserve still does), and the agent loop
retries a run that hits the usage limit on the key and runs on it until the limit resets, each run with
`--max-budget-usd` of `runBudgetUsd` or what is left of the month's, if less. It reports those runs' usage and records
with `apiKey: true`, and `spentThisMonthUsd` adds up their cost.

## Disk usage

The agent supervisor measures the disk space of each board's agent folder where the agents run and reports it (204)
with `POST /system/disk-usage` and `{ boards: { boardId, repo, worktrees, state }[] }`, in bytes. Each report replaces
the last one. The overview shows it (see `disk` above).

A board's **Disk usage** dialog (in its menu) shows what it is made of and frees some:

| Method | Path                                   | Body                 | Returns                       |
| ------ | -------------------------------------- | -------------------- | ----------------------------- |
| GET    | `/boards/:boardId/disk-usage`          |                      | `BoardDiskBreakdown`          |
| POST   | `/boards/:boardId/attachments/cleanup` | `{ olderThanDays? }` | `{ count, bytes }` it deleted |
| POST   | `/boards/:boardId/agent-cleanup`       |                      | `BoardSummary`                |

```ts
interface BoardDiskBreakdown {
  attachments: {
    images: { count: number; bytes: number } // screenshots: PNG, JPEG, GIF, WebP
    videos: { count: number; bytes: number } // screen recordings: MP4, WebM
    finished: { count: number; bytes: number } // those of finished tickets, which the cleanup deletes
    tickets: { ticketId: string; number: number; title: string; finished: boolean; count: number; bytes: number }[] // the 10 largest
  }
  agent: AgentDiskUsage | null // its agent folder (see `disk` in the overview)
}
```

A finished ticket is one in the board's done column (its last column if it has none) or its Cancelled column.
`attachments/cleanup` deletes the attachments of finished tickets, with `olderThanDays` (1-3650) only those uploaded
more than that many days ago, files included. `agent-cleanup` sets the board's `agentCleanupRequestedAt` and wakes its
agent: each of its loops then removes its checkout's ignored files (build output such as `node_modules/` or
`target/`) before its next run, right away when idle, never during a run (see `MAX_BUILD_GB` in docs/agents.md).

## Setup

What the Setup page (`/setup`) shows and does: the board's GitHub token, and the agents' logins, which the agent
supervisor runs where the agents run. `GET /system/setup` returns:

```ts
{
  github: {
    auth: 'board' | 'env' | 'gh' | null // the token set here, GITHUB_TOKEN, or the gh CLI's login, in that order
    login: string | null // the account it belongs to
    error: string | null // e.g. GitHub turned the token down
  }
  agents: {
    seenAt: string | null // when the supervisor last checked in; null if it never has
    runsIn: 'machine' | 'container' | null
    githubLogin: string | null // gh's account
    claudeAccount: string | null // claude's account email, "token" for CLAUDE_CODE_OAUTH_TOKEN
    gitIdentity: string | null // git's commit name and email
    apiKey: boolean // whether they have an API key for when Claude usage runs out (AGENT_API_KEY)
    login: {
      kind: 'github' | 'claude'
      state: 'requested' | 'waiting' | 'checking' | 'done' | 'failed'
      requestedAt: string
      url: string | null // github.com/login/device, or Claude's sign-in link
      userCode: string | null // GitHub's one-time code
      codeSent: boolean // Claude's code was pasted and waits for the supervisor
      message: string | null // why it failed, or who it logged in as
      updatedAt: string
    } | null
  }
  serverTime: string // the server's time: the page judges seenAt by it, as the browser's clock can be off from it
}
```

`PUT /system/github-token` with `{ token }` checks the token with GitHub (`400 github_error` when GitHub turns it
down), keeps it in the database and uses it from then on; the API never sends it back. `DELETE /system/github-token`
removes it. Both answer with the setup.

`PUT /system/typesafe-key` with `{ key }` checks the key with TypeSafe, keeps it in the database and uses it from then
on; the API never sends it back. `DELETE /system/typesafe-key` removes it. Both answer with the setup, whose
`typesafe.source` (`env` for `TYPESAFE_API_KEY`, which wins, `board`, or null) tells whether Jev can be used. See
[docs/JEV.md](JEV.md).

`POST /system/agents/login` (202) with `{ kind: "github" | "claude" }` asks the supervisor to log the agents in
(`409 login_in_progress` while one runs; a login stops after 15 minutes, counted from this request, and then shows as
`failed`). `POST /system/agents/login/code` with `{ code }` passes the code from Claude's sign-in page to it
(`409 login_not_waiting` unless a Claude login waits for one). `DELETE /system/agents/login` cancels it.

The supervisor checks in with `POST /system/agents` and `{ runsIn, githubLogin?, claudeAccount?, gitIdentity?, apiKey? }`
(`apiKey`: whether the agents have `AGENT_API_KEY`, never the key itself),
reads the login with `GET /system/agents/login` (with the pasted `code`), and reports on it with
`POST /system/agents/login/status` and `{ state, url?, userCode?, message? }`: `waiting` takes the request and says
what to show, `checking` takes the code, `done` and `failed` end it (`409 login_not_requested` when there is no login
running, e.g. it was cancelled or ran out of time). A supervisor that checks in while a login is `waiting` or `checking`
but runs none (it restarted) reports it `failed`.

## Switching the agents off and on

Every board's agents at once, from the button left of the update button in the header. Switched off, the agent
supervisor stops every board's loop and removes the containers their runs used, and starts none; switched on again, it
starts the loop of every board whose agent is on, as before. The boards' own agent settings stay as they are.
`GET /system/agents/services` returns:

```ts
{
  paused: boolean // switched off
  restart: boolean // the last switch on asked for the loops that run to be restarted too
  changedAt: string | null, changedBy: string | null // when it was last switched, and by whom
  wanted: string[] // the boards whose agent is on (with a repository): each should have a loop running unless paused
  running: string[] // the boards whose loop the supervisor last found running
  // boards where claim-next last failed (e.g. its moveTo column is gone), why, and since when; each stays until a
  // claim there goes through or finds nothing to do, or the supervisor reports its loop stopped; the usage reserve
  // holding agents back (usage_reserve_reached, see Claude usage) doesn't count as failing
  claimErrors: { boardId: string, message: string, since: string }[]
  reportedAt: string | null // when the supervisor last reported them; null if it never has
  handledAt: string | null // the changedAt it had seen to then: until it equals changedAt, the switch is on its way
  serverTime: string // the server's time, to judge reportedAt by: the browser's clock can be off from it
}
```

`PUT /system/agents/services` with `{ paused }` switches them off or on; the supervisor sees to it within a few
seconds. `{ paused: false }` while they are on starts the loops that aren't running now, rather than after the
supervisor's wait between retries, and `{ paused: false, restart: true }` also stops and starts the ones that run (with
the containers their runs use). When the supervisor can't read the switch, it goes by its last answer. It reports
the running loops after each poll with `POST /system/agents/services/status` and `{ running: string[], handledAt? }`,
the `changedAt` it saw to.

## Live updates

`GET /events?board=:boardId` is a server-sent event stream. It emits `change` events with data `{ "boardId": "..." }`
after every committed change (omit `board` to receive all boards), `wake` events with the same data when the board's
agent has something to look at now (`scripts/agent-loop.sh` ends its idle wait on one), plus periodic `ping` events.

The board sends a `wake` for what the agent loop counts as feedback on a ticket it holds (one with an assignee), by
anyone but that agent: a comment, an approved plan (`POST /tickets/:ticketId/approve`), and a move into the
`In progress` column (the loop's `IN_PROGRESS_COLUMN` default, by name, case-insensitive). The agent's own names
don't count: its assignee name, the agent's name before the first `/`, its loop's `<agent>-loop` and its other
workers' `<agent>/...`. It also sends one for fixing conflicts (`POST /boards/:boardId/fix-conflicts`), stopping a run
(`POST /tickets/:ticketId/stop`) and clearing build output (`POST /boards/:boardId/agent-cleanup`). Each change sends
at most one per board, and only once it is committed.

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
