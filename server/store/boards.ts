import {
  type AgentEffort,
  type AgentModelAlias,
  BACKLOG_COLUMN,
  CANCELLED_COLUMN,
  type BoardDetail,
  type BoardSummary,
  JEV_DEFAULTS,
  type JevMode,
  type TicketSize,
} from '../../shared/domain.ts'
import type { CreateBoardInput, UpdateBoardInput } from '../../shared/schemas.ts'
import { newId, now, sql, touchBoard, updateRow } from '../db.ts'
import { badRequest, notFound } from '../errors.ts'
import { typesafeKey } from '../typesafe.ts'
import { createColumn, listColumns, resolveColumn } from './columns.ts'
import { listEpics } from './epics.ts'
import { listTags } from './tags.ts'
import { listTickets, WAITING_SINCE } from './tickets.ts'

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
  agent_max_turns: number | null
  agent_conflict_concurrency: number | null
  agent_backlog: number
  agent_all_skills: number
  agent_docker: number
  auto_merge: number
  ignore_billing_failures: number
  delete_merged_branches: number
  archive_done_days: number | null
  approval_size: TicketSize | null
  notify_url: string | null
  agent_cleanup_requested_at: string | null
  jev_enabled: number
  jev_models: string | null
  jev_threshold: number | null
  jev_only_lower: number
  jev_mode: JevMode | null
  ticket_count: number
  waiting_count: number
  review_count: number
  backlog_count: number
  created_at: string
  updated_at: string
}

/** Whether the ticket `t` of the board `b` is still open: not in the done column or the cancelled one. */
const OPEN_TICKET = `
  t.column_id IS NOT b.done_column_id
  AND t.column_id NOT IN (SELECT id FROM columns WHERE board_id = b.id AND lower(name) = '${CANCELLED_COLUMN}')`

const SELECT_BOARDS = `
  SELECT b.*, (SELECT count(*) FROM tickets t WHERE t.board_id = b.id AND ${OPEN_TICKET}) AS ticket_count,
    (SELECT count(*) FROM tickets t
     WHERE t.board_id = b.id AND ${OPEN_TICKET} AND (t.approval = 'pending' OR ${WAITING_SINCE} IS NOT NULL))
      AS waiting_count,
    (SELECT count(*) FROM tickets WHERE column_id = b.review_column_id) AS review_count,
    (SELECT count(*) FROM tickets WHERE column_id IN
      (SELECT id FROM columns WHERE board_id = b.id AND lower(name) = '${BACKLOG_COLUMN}')) AS backlog_count
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
  agentMaxTurns: row.agent_max_turns,
  agentConflictConcurrency: row.agent_conflict_concurrency,
  agentBacklog: row.agent_backlog === 1,
  agentAllSkills: row.agent_all_skills === 1,
  agentDocker: row.agent_docker === 1,
  autoMerge: row.auto_merge === 1,
  ignoreBillingFailures: row.ignore_billing_failures === 1,
  deleteMergedBranches: row.delete_merged_branches === 1,
  archiveDoneDays: row.archive_done_days,
  approvalSize: row.approval_size,
  notifyUrl: row.notify_url,
  agentCleanupRequestedAt: row.agent_cleanup_requested_at,
  jevEnabled: row.jev_enabled === 1,
  jevModels: row.jev_models === null ? null : (JSON.parse(row.jev_models) as AgentModelAlias[]),
  jevThreshold: row.jev_threshold,
  jevOnlyLower: row.jev_only_lower === 1,
  jevMode: row.jev_mode,
  ticketCount: row.ticket_count,
  waitingCount: row.waiting_count,
  reviewCount: row.review_count,
  backlogCount: row.backlog_count,
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
    epics: listEpics(id),
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
    agentMaxTurns,
    agentConflictConcurrency,
    agentBacklog,
    agentAllSkills,
    agentDocker,
    autoMerge,
    ignoreBillingFailures,
    deleteMergedBranches,
    archiveDoneDays,
    approvalSize,
    notifyUrl,
    jevEnabled,
    jevModels,
    jevThreshold,
    jevOnlyLower,
    jevMode,
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
    agentMaxTurns,
    agentConflictConcurrency,
    agentBacklog,
    agentAllSkills,
    agentDocker,
    autoMerge,
    ignoreBillingFailures,
    deleteMergedBranches,
    archiveDoneDays,
    approvalSize,
    notifyUrl,
    jevEnabled,
    jevModels,
    jevThreshold,
    jevOnlyLower,
    jevMode,
  })
}

export function updateBoard(id: string, input: UpdateBoardInput): BoardSummary {
  touchBoard(id)
  if (input.jevEnabled && !typesafeKey()) throw badRequest('Set a TypeSafe API key before routing with Jev')
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
    agent_max_turns: input.agentMaxTurns,
    agent_conflict_concurrency: input.agentConflictConcurrency,
    agent_backlog: input.agentBacklog === undefined ? undefined : Number(input.agentBacklog),
    agent_all_skills: input.agentAllSkills === undefined ? undefined : Number(input.agentAllSkills),
    agent_docker: input.agentDocker === undefined ? undefined : Number(input.agentDocker),
    auto_merge: input.autoMerge === undefined ? undefined : Number(input.autoMerge),
    ignore_billing_failures:
      input.ignoreBillingFailures === undefined ? undefined : Number(input.ignoreBillingFailures),
    delete_merged_branches: input.deleteMergedBranches === undefined ? undefined : Number(input.deleteMergedBranches),
    archive_done_days: input.archiveDoneDays,
    approval_size: input.approvalSize,
    notify_url: input.notifyUrl,
    jev_enabled: input.jevEnabled === undefined ? undefined : Number(input.jevEnabled),
    jev_models: input.jevModels === undefined ? undefined : input.jevModels && JSON.stringify(input.jevModels),
    jev_threshold: input.jevThreshold,
    jev_only_lower: input.jevOnlyLower === undefined ? undefined : Number(input.jevOnlyLower),
    jev_mode: input.jevMode,
  })
  // A board that switches Jev on for the first time starts in dry run: it records Jev's picks without using them.
  if (input.jevEnabled && input.jevMode === undefined) {
    sql.run('UPDATE boards SET jev_mode = ? WHERE id = ? AND jev_mode IS NULL', JEV_DEFAULTS.mode, id)
  }
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
