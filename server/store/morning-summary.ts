import {
  JEV_AGENT,
  type MorningSummary,
  type MorningSummaryTicket,
  type PullRequestState,
} from '../../shared/domain.ts'
import { sql } from '../db.ts'
import { listBoards } from './boards.ts'
import { boardWorkflows, type ColumnRow, columnKey, isClosed } from './overview.ts'
import { WAITING_SINCE } from './tickets.ts'

const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000

interface TicketRow {
  id: string
  board_id: string
  column_id: string
  number: number
  title: string
  assignee: string | null
  pr_url: string | null
  pr_state: string
  waiting_since: string | null
}

/** Says briefly what happened on each board since `since` (by default the last 12 hours), and where that left things. */
export function getMorningSummary(since?: string, at = new Date()): MorningSummary {
  // Activity times are compared as text, so a time with an offset has to become the same format first.
  const start = new Date(since ?? at.getTime() - DEFAULT_WINDOW_MS).toISOString()

  const boards = listBoards()
  const columns = sql.all<ColumnRow>('SELECT id, board_id, name FROM columns ORDER BY board_id, position')
  const columnNames = new Map(columns.map((column) => [column.id, column.name]))
  const workflows = boardWorkflows(boards, columns)

  const summaries = new Map(
    boards.map((board) => [
      board.id,
      {
        id: board.id,
        name: board.name,
        completed: [] as MorningSummaryTicket[],
        review: [] as MorningSummaryTicket[],
        waiting: [] as MorningSummaryTicket[],
        created: 0,
        comments: 0,
        events: 0,
        usage: { runs: 0, tokens: 0, costUsd: null as number | null },
      },
    ]),
  )

  for (const row of sql.all<{ board_id: string; events: number; created: number; comments: number }>(
    `SELECT t.board_id, count(*) AS events, count(*) FILTER (WHERE a.type = 'created') AS created,
       count(*) FILTER (WHERE a.type = 'comment') AS comments
     FROM activity a JOIN tickets t ON t.id = a.ticket_id
     WHERE a.created_at >= ? GROUP BY t.board_id`,
    start,
  )) {
    const summary = summaries.get(row.board_id)!
    summary.events = row.events
    summary.created = row.created
    summary.comments = row.comments
  }

  // Jev isn't an agent: its requests count in the tokens and cost, but aren't runs.
  for (const row of sql.all<{ board_id: string; runs: number; tokens: number; cost: number | null }>(
    `SELECT board_id, count(*) FILTER (WHERE agent <> '${JEV_AGENT}') AS runs,
       sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens, sum(cost_usd) AS cost
     FROM token_usage WHERE created_at >= ? GROUP BY board_id`,
    start,
  )) {
    summaries.get(row.board_id)!.usage = { runs: row.runs, tokens: row.tokens, costUsd: row.cost }
  }

  // A ticket's last move within the window is what put it in the column it's in now.
  const movedAt = new Map(
    sql
      .all<{ ticket_id: string; at: string }>(
        `SELECT ticket_id, max(created_at) AS at FROM activity WHERE type = 'moved' AND created_at >= ? GROUP BY ticket_id`,
        start,
      )
      .map((row) => [row.ticket_id, row.at]),
  )
  const tickets = sql.all<TicketRow>(
    `SELECT id, board_id, column_id, number, title, assignee, pr_url, pr_state, ${WAITING_SINCE} AS waiting_since
     FROM tickets t WHERE id IN (SELECT ticket_id FROM activity WHERE created_at >= ?)`,
    start,
  )
  for (const ticket of tickets) {
    const summary = summaries.get(ticket.board_id)!
    const workflow = workflows.get(ticket.board_id)!
    const moved = movedAt.get(ticket.id)
    const pullRequestClosed = ticket.pr_state === 'closed'
    const entry = (when: string): MorningSummaryTicket => ({
      id: ticket.id,
      boardId: ticket.board_id,
      number: ticket.number,
      title: ticket.title,
      assignee: ticket.assignee,
      at: when,
      pullRequest: ticket.pr_url ? { url: ticket.pr_url, state: ticket.pr_state as PullRequestState } : null,
    })
    if (ticket.column_id === workflow.doneId) {
      if (moved) summary.completed.push(entry(moved))
    } else if (ticket.column_id === workflow.reviewId) {
      if (moved && !pullRequestClosed) summary.review.push(entry(moved))
    } else if (
      ticket.waiting_since &&
      ticket.waiting_since >= start &&
      !isClosed(workflow, columnKey(columnNames.get(ticket.column_id)!), pullRequestClosed)
    ) {
      summary.waiting.push(entry(ticket.waiting_since))
    }
  }

  const byTime = (a: MorningSummaryTicket, b: MorningSummaryTicket) => a.at.localeCompare(b.at)
  for (const summary of summaries.values()) {
    summary.completed.sort(byTime)
    summary.review.sort(byTime)
    summary.waiting.sort(byTime)
  }

  return { generatedAt: at.toISOString(), since: start, boards: [...summaries.values()] }
}
