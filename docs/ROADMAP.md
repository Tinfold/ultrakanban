# Roadmap: bugs, token savings and QOL

A review of the repository (server, UI, agent loop, docs) as of October 2026. The goal guiding the order: **spend fewer
tokens per finished ticket and send each ticket to the cheapest model that can do it well**. Haiku gets mechanical
work, Opus gets the hard parts, and everything else falls in between. Features that would add tokens to every run are
listed at the end as things not to build.

Each item gives a size (S, M or L) and a suggested `model/effort` for the ticket that does it, so the items can be
filed as they are. References are `file:line` at the time of writing.

## 1. Stop runs that do nothing (biggest savings)

Each of these starts a full `claude -p` run, at the board's model (Opus by default), that has nothing to do.

| #   | Item                                                                                                                                                                                                                                                            | Size | Model/effort  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------- |
| 1.1 | An APPROVED or DISMISSED review with an empty body counts as feedback (`scripts/agent-loop/triage.sh:43-44`). Only empty COMMENTED reviews are skipped. Skip empty reviews of any state.                                                                        | S    | sonnet/low    |
| 1.2 | Acknowledgement comments ("thanks", "LGTM", a lone emoji) start runs (`triage.sh:31-32,41-42`). Skip short acks, or add a board setting so only comments that mention the agent count.                                                                          | S    | sonnet/medium |
| 1.3 | A PR that stays in conflict starts a new run every time the base branch moves (conflict key `headRefOid:baseRefOid`, `triage.sh:78-80`), with no cap like `MAX_CI_RUNS`. Add a `MAX_CONFLICT_RUNS`.                                                             | S    | sonnet/medium |
| 1.4 | The first run's snapshot only stores the activity id (`tickets.sh:285`). A re-claimed ticket that already has a PR gets every old PR comment handed over again as new feedback. Snapshot the PR watermarks too.                                                 | S    | sonnet/medium |
| 1.5 | A run that posts one PR comment without the `<!-- ultrakanban:... -->` marker triggers its own next run (`triage.sh:19`), since it posts from the reviewer's `gh` account. Also skip PR comments posted while one of the agent's runs was going on that ticket. | M    | opus/medium   |

## 2. Make each run cheaper

| #   | Item                                                                                                                                                                                                                                                                                                                                                          | Size | Model/effort  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------- |
| 2.1 | **Cheaper model per trigger.** Merge-conflict runs, CI-fix runs and short comment replies all run at the ticket's (or board's) model and effort (`tickets.sh:162`). Add board settings such as `conflictModel`/`conflictEffort`, defaulting to sonnet/medium.                                                                                                 | M    | opus/medium   |
| 2.2 | **Resume the last session after approval and for review feedback.** A successful run replaces the state with the snapshot and drops the session (`run.sh:524-527`, `tickets.sh:175`). So the work run after a plan approval, and every review reply, starts cold and explores the code again. Keep the session id and resume it.                              | M    | opus/high     |
| 2.3 | Resumed runs get the whole prompt again: intro, board description, items, checklist (`run.sh:485-493`). Send only the new feedback.                                                                                                                                                                                                                           | S    | sonnet/medium |
| 2.4 | The feedback prompt tells the agent to re-read all activity, PR comments, reviews and checks (`tickets.sh:181-184`), even though the new items are already in the prompt. Say "the new feedback is above; fetch more only if you need context".                                                                                                               | S    | sonnet/low    |
| 2.5 | **Slim the skill.** `SKILL.md` (17.5 KB, roughly 4.5k tokens) goes into every run's system prompt (`run.sh:273-281`), including sections a worker never uses (creating tickets, epics, splitting, the orchestration rules). Ship a worker version with only claim/plan/checklist/review/feedback, and link the rest.                                          | S    | sonnet/medium |
| 2.6 | Skip the plan step for small tickets when the board has no `approvalSize` (`tickets.sh:292-296`), or let the plan be one line. It costs a turn on every claim.                                                                                                                                                                                                | S    | sonnet/low    |
| 2.7 | Pass `--max-turns` (a board setting) to `claude` (`run.sh:413`). Today a runaway run is limited only by the 4h `TICKET_TIMEOUT`, and it is retried up to `MAX_ATTEMPTS` times from scratch.                                                                                                                                                                   | S    | sonnet/low    |
| 2.8 | Lean API responses for agents: `GET /boards/:id` and `/boards/:id/tickets` return every ticket with its full description (`server/store/tickets.ts:127-141`, `boards.ts:104`). Add `?fields=`/`?compact=1` and a `column`/`assignee` filter. Add `?afterId=&type=comment` to `/tickets/:id/activity` (`activity.ts:28`). Then use them in the skill and loop. | M    | opus/medium   |
| 2.9 | 409 errors put the whole ticket in `details` (`tickets.ts:325-328,401-407,613`). `{version, assignee, columnId}` is enough to retry.                                                                                                                                                                                                                          | S    | haiku/low     |

## 3. Route tickets to the right model

The suggestion endpoint exists but is only used in the new-ticket form. Tickets filed by agents or through the API run
on the board default (`opus/medium`).

| #   | Item                                                                                                                                                                                                                                                                                                                | Size | Model/effort  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------- |
| 3.1 | **Auto-route on claim.** When a ticket has no `agentModel`/`agentEffort`, have the loop call `/agent-suggestion` for it and use the suggestion when there is enough history (say 3 or more similar tickets), as a board setting. No LLM call is needed.                                                             | M    | opus/medium   |
| 3.2 | Show the ticket's model/effort on its card (`src/components/board/TicketCard.tsx:120-127`) and in the plan-approval banner, with a picker there (`PlanApproval.tsx:28-36`). Approval is the moment to downgrade an `S` plan that's about to run on opus/high.                                                       | S    | sonnet/medium |
| 3.3 | Offer the suggestion button on existing tickets, not only in the create form (`TicketProperties.tsx:106-140`).                                                                                                                                                                                                      | S    | sonnet/medium |
| 3.4 | Bulk-set model/effort (`BulkActionBar.tsx:40`, `shared/schemas.ts:222-232`).                                                                                                                                                                                                                                        | M    | sonnet/medium |
| 3.5 | Better suggestion math (`server/store/suggestions.ts`): compare cost per _finished_ ticket (cost / success rate), not per ticket (`:186`). Weight tokens by type when no cost is reported, because cache reads dominate the raw totals (`:115`). Use the plan estimate as a feature. Require a minimum sample size. | M    | opus/medium   |
| 3.6 | Add a haiku/low "Small change" template, and make the Bug template sonnet/medium as the skill recommends (`shared/domain.ts:76-101` vs `SKILL.md`). Add a one-line cost hint per model in the picker (`pickers.tsx:101-133`).                                                                                       | S    | haiku/low     |
| 3.7 | A per-setting report on the overview: cost and success rate per model/effort. The data is already computed inside the suggestion endpoint.                                                                                                                                                                          | M    | opus/medium   |
| 3.8 | `ModelPicker` lists Claude aliases on boards whose agent isn't Claude, and has no free-text entry (`pickers.tsx:117`).                                                                                                                                                                                              | S    | sonnet/medium |

## 4. Bugs

| #    | Item                                                                                                                                                                                                                                   | Size | Model/effort  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------- |
| 4.1  | `DELETE /columns/:id` without `moveTicketsTo` deletes every ticket in the column, with its activity and usage (`server/routes/columns.ts:22-29`, cascade in `server/db.ts:37`). Return 409 when the column isn't empty.                | S    | sonnet/medium |
| 4.2  | `token_usage.ticket_id` is `ON DELETE CASCADE` (`server/db.ts:134`), so deleting tickets erases their spend from board totals and from the history suggestions learn from. Use `SET NULL` (needs a migration that rebuilds the table). | S    | sonnet/medium |
| 4.3  | Description saves send no `ifVersion` (`src/hooks/use-board-actions.ts:154-159`). A person editing a description silently overwrites checklist steps an agent ticks meanwhile.                                                         | M    | opus/medium   |
| 4.4  | A failed refetch replaces a loaded board with "Board not found" (`src/pages/BoardPage.tsx:33`), and the same happens on the overview (`OverviewPage.tsx:252`). Show cached data and a toast instead.                                   | S    | sonnet/medium |
| 4.5  | `POST /tickets/:id/claim` skips the usage reserve, blocked tags, `blocked by #N` and unfinished sub-tickets, all of which `claim-next` checks (`server/store/tickets.ts:609-620`).                                                     | S    | sonnet/medium |
| 4.6  | A usage report with only an error clears the limits (`server/store/claude-usage.ts:116`), so one failed read lifts the usage reserve. Keep the last limits until they go stale (decide whether to fail open or closed).                | S    | sonnet/medium |
| 4.7  | Plan self-approval and `waitingSince` compare `actor === assignee` strictly (`tickets.ts:874`, `:109`). Other names of the same agent slip through. Reuse `isAgentOf`.                                                                 | M    | sonnet/medium |
| 4.8  | `releaseIdleTickets` relocates without `force` (`tickets.ts:728`), so releasing into the done column rolls the whole batch back at the first ticket without a merged PR.                                                               | S    | sonnet/low    |
| 4.9  | Ticket search puts `q` into `LIKE` unescaped, so `%` and `_` act as wildcards (`tickets.ts:316-317`).                                                                                                                                  | S    | haiku/low     |
| 4.10 | The loop's INT/TERM trap exits without `end_run`/`record_run`/`stop_leftovers` (`scripts/agent-loop.sh:289`), so the board shows a dead run and its child processes keep running.                                                      | S    | sonnet/medium |
| 4.11 | `timeout --foreground` without `-k` (`run.sh:413`) never force-kills a run that ignores TERM.                                                                                                                                          | S    | haiku/low     |
| 4.12 | `ci.sh:12-23` reads tab-separated rows with `read`. Empty fields collapse, so the columns shift and checks get misclassified as infrastructure (or not).                                                                               | S    | sonnet/medium |
| 4.13 | `agent-board.sh:148-153` can unset the wrong loop's pid when `wait -n -p` returns an unknown pid.                                                                                                                                      | S    | sonnet/low    |
| 4.14 | Without `AGENT_LOOP_CLEAN`, the prompt still says the checkout is "freshly updated from origin" (`run.sh:508-512`).                                                                                                                    | S    | haiku/low     |
| 4.15 | Resuming a session from another checkout (`run.sh:484-490`) likely fails, because Claude stores sessions per project directory. Verify this and copy the session file across, or don't offer the resume.                               | M    | opus/high     |
| 4.16 | The auto-merge state resets `since` when only `failed` changes (`server/store/auto-merge.ts:41-50`), which contradicts its doc comment.                                                                                                | S    | sonnet/low    |
| 4.17 | The by-tag cost per ticket divides costed spend by all tickets (`src/lib/overview.ts:193,202`).                                                                                                                                        | S    | haiku/low     |
| 4.18 | Clipboard writes have no catch (`TicketDialog.tsx:69-72`, `CopyButton.tsx:17-18`), so copying fails silently over plain HTTP.                                                                                                          | S    | haiku/low     |

## 5. Load and QOL

| #   | Item                                                                                                                                                                                                                                         | Size | Model/effort  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------- |
| 5.1 | GitHub API use: about 6-8 calls per held ticket per round, with no caching (`tickets.sh:113-124`, `ci.sh`). With many tickets in review this nears the 5000/h limit. Skip unchanged PRs: check `updatedAt` from one `gh pr list` call first. | M    | opus/medium   |
| 5.2 | The full board is fetched several times per round and per run (`checkout.sh:102`, `tickets.sh:66,203`, `run.sh:278,309,603`). Fetch it once per round (with `compact`, see 2.8).                                                             | S    | sonnet/medium |
| 5.3 | Wake-ups that arrive during triage or a run are lost (`agent-loop.sh:260-275`). Keep a wake flag file and check it before idling.                                                                                                            | S    | sonnet/medium |
| 5.4 | Changing the board's model or effort restarts loops right away and kills runs in progress (`agent-supervisor.sh:566-570`). Wait for the run to finish, as script updates do (exit 75).                                                       | M    | opus/medium   |
| 5.5 | Add indexes `activity(created_at)` and `activity(actor, id)` for the overview queries (`server/db.ts:57-66`, `overview.ts:129,301,321`).                                                                                                     | S    | haiku/low     |
| 5.6 | Return `usage_reserve_reached` as 429 with `Retry-After` instead of 404 (`tickets.ts:739-752`). Mind the loop and skill, which match on it.                                                                                                  | S    | sonnet/medium |
| 5.7 | Make the heartbeat return `{stopRequested}` so loops needn't poll the ticket (`routes/tickets.ts:187`).                                                                                                                                      | S    | sonnet/low    |
| 5.8 | Show live tokens/cost on a running ticket's status line (`RunStatus.tsx`) and tokens on run records (`ActivityFeed.tsx:200-221`), so runaway runs show up while they run.                                                                    | M    | opus/medium   |
| 5.9 | Filter and sort the board by model, effort, estimate and cost (`src/lib/board-view.ts`, `FilterMenu.tsx`).                                                                                                                                   | M    | sonnet/medium |

## 6. Docs

All `haiku/low`, one ticket for the lot:

- `docs/features.md` leaves out filtering by epic, bulk-setting the epic, per-ticket model/effort, templates and suggestions.
- `docs/API.md:321,418` documents `agentEffort` as a string, but it is an enum.
- The `fable` alias (`shared/domain.ts:20`) isn't mentioned in the README, the docs or the skill.

## Suggested order

1. Section 1 (1.1–1.4) and 2.4, 2.7: small script changes that cut wasted runs right away.
2. 4.1, 4.2, 4.3, 4.6: data loss and a reserve that can lift itself.
3. 3.1, 3.2, 3.6: get tickets onto cheaper models by default.
4. 2.1, 2.2, 2.5: the larger per-run savings.
5. The rest as capacity allows.

## Not recommended (would add usage)

- An LLM triage pass that picks a model for every ticket. Use the suggestion endpoint (3.1) instead: it costs nothing.
- Having agents post more progress comments, or screenshots of non-visual changes.
- Automatic reviewer agents on every PR. If wanted, make it opt-in per ticket and run it on haiku or sonnet.
- Retrying failed runs more often, or with a higher effort automatically.
