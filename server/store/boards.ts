import type { AgentEffort, BoardDetail, BoardSummary } from '../../shared/domain.ts'
import type { CreateBoardInput, UpdateBoardInput } from '../../shared/schemas.ts'
import { newId, now, sql, touchBoard, updateRow } from '../db.ts'
import { badRequest, notFound } from '../errors.ts'
import { createColumn, listColumns, resolveColumn } from './columns.ts'
import { listTags } from './tags.ts'
import { listTickets } from './tickets.ts'

interface BoardRow {
  id: string
  name: string
  description: string
  review_column_id: string | null
  done_column_id: string | null
  github_repo: string | null
  agent_enabled: number
  agent_name: string | null
  agent_model: string | null
  agent_effort: AgentEffort | null
  agent_concurrency: number | null
  agent_backlog: number
  agent_all_skills: number
  auto_merge: number
  archive_done_days: number | null
  ticket_count: number
  created_at: string
  updated_at: string
}

const SELECT_BOARDS = `
  SELECT b.*, (SELECT count(*) FROM tickets WHERE board_id = b.id) AS ticket_count
  FROM boards b`

const toBoard = (row: BoardRow): BoardSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  reviewColumnId: row.review_column_id,
  doneColumnId: row.done_column_id,
  githubRepo: row.github_repo,
  agentEnabled: row.agent_enabled === 1,
  agentName: row.agent_name,
  agentModel: row.agent_model,
  agentEffort: row.agent_effort,
  agentConcurrency: row.agent_concurrency,
  agentBacklog: row.agent_backlog === 1,
  agentAllSkills: row.agent_all_skills === 1,
  autoMerge: row.auto_merge === 1,
  archiveDoneDays: row.archive_done_days,
  ticketCount: row.ticket_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export function listBoards(): BoardSummary[] {
  return sql.all<BoardRow>(`${SELECT_BOARDS} ORDER BY b.updated_at DESC`).map(toBoard)
}

export function getBoard(id: string): BoardSummary {
  const row = sql.get<BoardRow>(`${SELECT_BOARDS} WHERE b.id = ?`, id)
  if (!row) throw notFound('Board', id)
  return toBoard(row)
}

/** The board with its tickets, leaving out archived ones unless `archived` is set. */
export function getBoardDetail(id: string, { archived = false } = {}): BoardDetail {
  const tickets = listTickets(id)
  const shown = archived ? tickets : tickets.filter((ticket) => !ticket.archived)
  return {
    board: getBoard(id),
    columns: listColumns(id),
    tags: listTags(id),
    tickets: shown,
    archivedCount: tickets.length - shown.length,
  }
}

export function createBoard(input: CreateBoardInput): BoardSummary {
  const id = newId()
  const timestamp = now()
  sql.run(
    'INSERT INTO boards (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id,
    input.name,
    input.description ?? '',
    timestamp,
    timestamp,
  )
  for (const name of input.columns ?? []) createColumn(id, { name })
  const {
    reviewColumn,
    doneColumn,
    githubRepo,
    agentEnabled,
    agentName,
    agentModel,
    agentEffort,
    agentConcurrency,
    agentBacklog,
    agentAllSkills,
    autoMerge,
    archiveDoneDays,
  } = input
  return updateBoard(id, {
    reviewColumn,
    doneColumn,
    githubRepo,
    agentEnabled,
    agentName,
    agentModel,
    agentEffort,
    agentConcurrency,
    agentBacklog,
    agentAllSkills,
    autoMerge,
    archiveDoneDays,
  })
}

export function updateBoard(id: string, input: UpdateBoardInput): BoardSummary {
  touchBoard(id)
  const columnId = (ref: string | null | undefined) => (ref ? resolveColumn(id, ref).id : ref)
  updateRow('boards', id, {
    name: input.name,
    description: input.description,
    review_column_id: columnId(input.reviewColumn),
    done_column_id: columnId(input.doneColumn),
    github_repo: input.githubRepo,
    agent_enabled: input.agentEnabled === undefined ? undefined : Number(input.agentEnabled),
    agent_name: input.agentName,
    agent_model: input.agentModel,
    agent_effort: input.agentEffort,
    agent_concurrency: input.agentConcurrency,
    agent_backlog: input.agentBacklog === undefined ? undefined : Number(input.agentBacklog),
    agent_all_skills: input.agentAllSkills === undefined ? undefined : Number(input.agentAllSkills),
    auto_merge: input.autoMerge === undefined ? undefined : Number(input.autoMerge),
    archive_done_days: input.archiveDoneDays,
  })
  const board = getBoard(id)
  if (board.agentEnabled && !board.githubRepo) {
    throw badRequest('Set the GitHub repository before switching the agent on')
  }
  return board
}

export function deleteBoard(id: string) {
  touchBoard(id)
  sql.run('DELETE FROM boards WHERE id = ?', id)
}
