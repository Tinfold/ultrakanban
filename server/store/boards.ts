import type { BoardDetail, BoardSummary } from '../../shared/domain.ts'
import type { CreateBoardInput, UpdateBoardInput } from '../../shared/schemas.ts'
import { newId, now, sql, touchBoard, updateRow } from '../db.ts'
import { notFound } from '../errors.ts'
import { createColumn, listColumns, resolveColumn } from './columns.ts'
import { listTags } from './tags.ts'
import { listTickets } from './tickets.ts'

interface BoardRow {
  id: string
  name: string
  description: string
  review_column_id: string | null
  done_column_id: string | null
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

export function getBoardDetail(id: string): BoardDetail {
  return { board: getBoard(id), columns: listColumns(id), tags: listTags(id), tickets: listTickets(id) }
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
  return updateBoard(id, { reviewColumn: input.reviewColumn, doneColumn: input.doneColumn })
}

export function updateBoard(id: string, input: UpdateBoardInput): BoardSummary {
  touchBoard(id)
  const columnId = (ref: string | null | undefined) => (ref ? resolveColumn(id, ref).id : ref)
  updateRow('boards', id, {
    name: input.name,
    description: input.description,
    review_column_id: columnId(input.reviewColumn),
    done_column_id: columnId(input.doneColumn),
  })
  return getBoard(id)
}

export function deleteBoard(id: string) {
  touchBoard(id)
  sql.run('DELETE FROM boards WHERE id = ?', id)
}
