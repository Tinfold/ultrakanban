# Features

- **Boards**: create from templates, switch quickly, rename, export to and import from JSON files
- **Columns**: add, rename, recolor, reorder by drag or menu, WIP limits, delete (optionally moving tickets)
- **Tickets**: markdown description in a rich editor (headings, lists, checklists, code, links), priority,
  assignee, due date, tags, comments, full activity history, shareable links (`?ticket=<id>`)
- **View**: search, filter by priority/tag/assignee, sort by manual order, priority, due date, recency or title
  (saved per board)
- **Attachments**: screenshots and screen recordings on tickets (upload, drag and drop or paste), shown in the
  ticket and its activity
- **Pull request workflow**: agents submit tickets for review with their GitHub pull request; tickets only enter
  Done once the pull request is merged and move there automatically when it is. Questions (tickets tagged
  `question`) are answered in a comment instead, and you close them yourself by moving them to Done
- **Sub-tickets**: agents split a big ticket into sub-tickets that link back to it; its card shows how many are done,
  and the agent comes back to it only once they all are
- **Epics**: group the tickets of a larger feature, sub-tickets included, in a bar above the columns with each epic's
  progress; click one to see only its tickets. An epic is done once all its tickets are, and agents filing several
  tickets for one feature put them in an epic
- **Plans and approval**: agents post a short plan with a size estimate (S, M or L) when they start a ticket;
  optionally, per board, tickets estimated at a given size or larger wait for you to approve the plan on the ticket
  before the agent spends more tokens on them
- **Merge all**: merge every pull request in review with one click, one at a time and in an order that avoids
  conflicts (stacked pull requests after the ones they build on); any that conflict after earlier merges are skipped
  for their agent to resolve
- **Fix conflicts**: ask the agents to fix the merge conflicts of the pull requests in review with one click (the
  conflict button on the review column); it comments on each of those tickets and wakes the agent loops up
- **Quick merge**: merge a single ticket's pull request from its card in the review column
- **Auto-merge**: optionally, per board, merge pull requests in review by themselves once they have no conflicts,
  every check has passed and every checklist item of their ticket is checked
- **Delete branches after merge**: optionally, per board, delete a pull request's branch on GitHub once it is merged,
  moving the pull requests stacked on it to its base first
- **Notifications**: optionally, per board, send an ntfy, Discord or webhook message when a ticket needs you: an agent
  asks a question, CI needs someone, a plan waits for approval, a question is answered or a pull request is ready to merge
- **Archiving**: optionally, per board, hide tickets that have been done for a number of days, so the done column and
  the board agents read stay small; search still finds them and the filter menu can show them
- **Overview**: a dashboard across all boards (`/overview`): which agents are working on what right now, time
  worked, tokens used and tickets completed per agent, activity, work time and token usage per day (by type and by model, e.g. Opus or Haiku), per-board counts
  and a cross-board feed; stale or duplicate agents can be cleared from it
- **Bulk changes**: select several tickets (ctrl/⌘-click, shift-click for a range, or the Select button, which makes
  a tap select on phones) to move, tag, set the priority of or delete them together
- **Live**: changes made by agents or other tabs show up right away (server-sent events)
- **Responsive**: works with a mouse, keyboard or touch (long-press to drag); light, dark and system themes

## Keyboard

| Key            | Action                                            |
| -------------- | ------------------------------------------------- |
| `C`            | New ticket                                        |
| `/`            | Search                                            |
| `Enter`        | Open focused ticket                               |
| `X`            | Select tickets, `Esc` to stop                     |
| `Space`        | Pick up / drop focused ticket, arrow keys to move |
| `⌘/Ctrl+Enter` | Create ticket / post comment                      |
