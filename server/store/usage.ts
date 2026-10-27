import type { SQLInputValue } from 'node:sqlite'
import {
  type AgentEffort,
  type ModelUsage,
  type RoutingSource,
  type RunRouting,
  type TokenUsage,
  totalTokens,
} from '../../shared/domain.ts'
import type { RecordUsage } from '../../shared/schemas.ts'
import { now, sql, touchBoard } from '../db.ts'
import { getBoard } from './boards.ts'
import { runRouting, toRunRouting } from './routing.ts'
import { getTicket } from './tickets.ts'

interface UsageRow {
  id: number
  board_id: string
  ticket_id: string | null
  agent: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number | null
  api_key: number
  duration_ms: number | null
  routing_source: RoutingSource | null
  routing_confidence: number | null
  jev_model: string | null
  jev_effort: AgentEffort | null
  jev_confidence: number | null
  created_at: string
}

interface ModelRow {
  usage_id: number
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number | null
}

const toModelUsage = (row: ModelRow): ModelUsage => ({
  model: row.model,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  costUsd: row.cost_usd,
})

const toUsage = (row: UsageRow, models: ModelUsage[]): TokenUsage => ({
  id: row.id,
  boardId: row.board_id,
  ticketId: row.ticket_id,
  agent: row.agent,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  costUsd: row.cost_usd,
  apiKey: row.api_key === 1,
  durationMs: row.duration_ms,
  models: models.sort((a, b) => totalTokens(b) - totalTokens(a) || a.model.localeCompare(b.model)),
  routing: toRunRouting(row),
  createdAt: row.created_at,
})

/** Runs matching an SQL condition on `token_usage`, oldest first, with their split by model. */
export function queryUsage(where: string, ...params: SQLInputValue[]): TokenUsage[] {
  const models = new Map<number, ModelUsage[]>()
  const modelRows = sql.all<ModelRow>(
    `SELECT * FROM token_usage_models WHERE usage_id IN (SELECT id FROM token_usage WHERE ${where})`,
    ...params,
  )
  for (const row of modelRows) {
    const list = models.get(row.usage_id) ?? []
    list.push(toModelUsage(row))
    models.set(row.usage_id, list)
  }
  return sql
    .all<UsageRow>(`SELECT * FROM token_usage WHERE ${where} ORDER BY created_at, id`, ...params)
    .map((row) => toUsage(row, models.get(row.id) ?? []))
}

export function listUsage(ticketId: string): TokenUsage[] {
  getTicket(ticketId)
  return queryUsage('ticket_id = ?', ticketId)
}

/** Every run reported on a board, on its tickets or not. */
export function listBoardUsage(boardId: string): TokenUsage[] {
  getBoard(boardId)
  return queryUsage('board_id = ?', boardId)
}

/** Records the tokens an agent run used on a ticket, with how the run was routed (see `runRouting`). */
export function recordUsage(ticketId: string, input: RecordUsage): TokenUsage {
  const ticket = getTicket(ticketId)
  return insertUsage(ticket.boardId, ticket.id, input, runRouting(ticket.id, input.agent))
}

/** Records the tokens an agent run used on a board without working a ticket. */
export const recordBoardUsage = (boardId: string, input: RecordUsage): TokenUsage =>
  insertUsage(boardId, null, input, null)

function insertUsage(
  boardId: string,
  ticketId: string | null,
  input: RecordUsage,
  routing: RunRouting | null,
): TokenUsage {
  touchBoard(boardId)
  const { lastInsertRowid } = sql.run(
    `INSERT INTO token_usage
       (board_id, ticket_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
        api_key, duration_ms, routing_source, routing_confidence, jev_model, jev_effort, jev_confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    boardId,
    ticketId,
    input.agent,
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens,
    input.cacheWriteTokens,
    input.costUsd,
    input.apiKey ? 1 : 0,
    input.durationMs,
    routing?.source ?? null,
    routing?.confidence ?? null,
    routing?.jev?.model ?? null,
    routing?.jev?.effort ?? null,
    routing?.jev?.confidence ?? null,
    now(),
  )
  for (const model of input.models) {
    sql.run(
      `INSERT INTO token_usage_models
         (usage_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      lastInsertRowid,
      model.model,
      model.inputTokens,
      model.outputTokens,
      model.cacheReadTokens,
      model.cacheWriteTokens,
      model.costUsd,
    )
  }
  return queryUsage('id = ?', lastInsertRowid)[0]
}
