import type { TokenUsage } from '../../shared/domain.ts'
import type { RecordUsage } from '../../shared/schemas.ts'
import { now, sql, touchBoard } from '../db.ts'
import { getBoard } from './boards.ts'
import { getTicket } from './tickets.ts'

export interface UsageRow {
  id: number
  board_id: string
  ticket_id: string | null
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
  boardId: row.board_id,
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

/** Every run reported on a board, on its tickets or not. */
export function listBoardUsage(boardId: string): TokenUsage[] {
  getBoard(boardId)
  return sql.all<UsageRow>('SELECT * FROM token_usage WHERE board_id = ? ORDER BY id', boardId).map(toUsage)
}

/** Records the tokens an agent run used on a ticket. */
export function recordUsage(ticketId: string, input: RecordUsage): TokenUsage {
  const ticket = getTicket(ticketId)
  return insertUsage(ticket.boardId, ticket.id, input)
}

/** Records the tokens an agent run used on a board without working a ticket. */
export const recordBoardUsage = (boardId: string, input: RecordUsage): TokenUsage => insertUsage(boardId, null, input)

function insertUsage(boardId: string, ticketId: string | null, input: RecordUsage): TokenUsage {
  touchBoard(boardId)
  const { lastInsertRowid } = sql.run(
    `INSERT INTO token_usage
       (board_id, ticket_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
        duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    boardId,
    ticketId,
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
