import type { TokenUsage } from '../../shared/domain.ts'
import type { RecordUsage } from '../../shared/schemas.ts'
import { now, sql, touchBoard } from '../db.ts'
import { getTicket } from './tickets.ts'

export interface UsageRow {
  id: number
  ticket_id: string
  agent: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number | null
  duration_ms: number | null
  created_at: string
}

export const toUsage = (row: UsageRow): TokenUsage => ({
  id: row.id,
  ticketId: row.ticket_id,
  agent: row.agent,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  costUsd: row.cost_usd,
  durationMs: row.duration_ms,
  createdAt: row.created_at,
})

export function listUsage(ticketId: string): TokenUsage[] {
  getTicket(ticketId)
  return sql.all<UsageRow>('SELECT * FROM token_usage WHERE ticket_id = ? ORDER BY id', ticketId).map(toUsage)
}

/** Records the tokens an agent run used on a ticket. */
export function recordUsage(ticketId: string, input: RecordUsage): TokenUsage {
  const ticket = getTicket(ticketId)
  touchBoard(ticket.boardId)
  const { lastInsertRowid } = sql.run(
    `INSERT INTO token_usage
       (ticket_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ticket.id,
    input.agent,
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens,
    input.cacheWriteTokens,
    input.costUsd,
    input.durationMs,
    now(),
  )
  return toUsage(sql.get<UsageRow>('SELECT * FROM token_usage WHERE id = ?', lastInsertRowid)!)
}
