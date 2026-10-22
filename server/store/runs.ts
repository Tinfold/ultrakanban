import { RUN_RECORDS_KEPT, type RunOutcome, type RunRecord, type RunStep } from '../../shared/domain.ts'
import type { RecordRun } from '../../shared/schemas.ts'
import { now, sql, touchBoard } from '../db.ts'
import { getTicket } from './tickets.ts'

interface RunRow {
  id: number
  ticket_id: string
  agent: string
  outcome: RunOutcome
  exit_code: number | null
  duration_ms: number | null
  turns: number | null
  cost_usd: number | null
  api_key: number
  message: string
  steps: string
  omitted_after: number | null
  omitted_count: number | null
  created_at: string
}

const toRun = (row: RunRow): RunRecord => ({
  id: row.id,
  ticketId: row.ticket_id,
  agent: row.agent,
  outcome: row.outcome,
  exitCode: row.exit_code,
  durationMs: row.duration_ms,
  turns: row.turns,
  costUsd: row.cost_usd,
  apiKey: row.api_key === 1,
  message: row.message,
  steps: JSON.parse(row.steps) as RunStep[],
  omittedSteps:
    row.omitted_after !== null && row.omitted_count ? { after: row.omitted_after, count: row.omitted_count } : null,
  createdAt: row.created_at,
})

/** The ticket's latest run records, newest first. */
export function listRuns(ticketId: string, limit: number): RunRecord[] {
  getTicket(ticketId)
  return sql
    .all<RunRow>('SELECT * FROM run_records WHERE ticket_id = ? ORDER BY id DESC LIMIT ?', ticketId, limit)
    .map(toRun)
}

/**
 * Records what an agent run on the ticket did and how it ended, and deletes the ticket's records beyond the newest
 * `RUN_RECORDS_KEPT`, so a ticket that is retried for days doesn't pile them up. Boards are told, so the ticket's
 * activity shows it.
 */
export function recordRun(ticketId: string, input: RecordRun): RunRecord {
  const ticket = getTicket(ticketId)
  touchBoard(ticket.boardId)
  const { lastInsertRowid } = sql.run(
    `INSERT INTO run_records
       (ticket_id, agent, outcome, exit_code, duration_ms, turns, cost_usd, api_key, message, steps, omitted_after,
        omitted_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ticket.id,
    input.agent,
    input.outcome,
    input.exitCode,
    input.durationMs,
    input.turns,
    input.costUsd,
    input.apiKey ? 1 : 0,
    input.message,
    JSON.stringify(input.steps),
    input.omittedSteps?.after ?? null,
    input.omittedSteps?.count ?? null,
    now(),
  )
  sql.run(
    `DELETE FROM run_records WHERE ticket_id = ?
       AND id NOT IN (SELECT id FROM run_records WHERE ticket_id = ? ORDER BY id DESC LIMIT ?)`,
    ticket.id,
    ticket.id,
    RUN_RECORDS_KEPT,
  )
  return toRun(sql.get<RunRow>('SELECT * FROM run_records WHERE id = ?', lastInsertRowid)!)
}
