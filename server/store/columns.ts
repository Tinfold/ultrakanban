import type { Color, Column } from '../../shared/domain.ts'
import type { CreateColumnInput, UpdateColumnInput } from '../../shared/schemas.ts'
import { newId, reorder, sql, touchBoard, updateRow } from '../db.ts'
import { notFound } from '../errors.ts'

interface ColumnRow {
  id: string
  board_id: string
  name: string
  color: string
  wip_limit: number | null
  position: number
}

const toColumn = (row: ColumnRow): Column => ({
  id: row.id,
  boardId: row.board_id,
  name: row.name,
  color: row.color as Color,
  wipLimit: row.wip_limit,
  position: row.position,
})

export function listColumns(boardId: string): Column[] {
  return sql.all<ColumnRow>('SELECT * FROM columns WHERE board_id = ? ORDER BY position', boardId).map(toColumn)
}

export function getColumn(id: string): Column {
  const row = sql.get<ColumnRow>('SELECT * FROM columns WHERE id = ?', id)
  if (!row) throw notFound('Column', id)
  return toColumn(row)
}

/** Finds a column of a board by id, or by case-insensitive name (leftmost match wins). */
export function resolveColumn(boardId: string, ref: string): Column {
  const row = sql.get<ColumnRow>(
    `SELECT * FROM columns WHERE board_id = ? AND (id = ? OR name = ? COLLATE NOCASE)
     ORDER BY id = ? DESC, position LIMIT 1`,
    boardId,
    ref,
    ref,
    ref,
  )
  if (!row) throw notFound('Column', ref)
  return toColumn(row)
}

/** The board's pull request workflow columns, if configured. */
export function workflowColumns(boardId: string) {
  const row = sql.get<{ review_column_id: string | null; done_column_id: string | null }>(
    'SELECT review_column_id, done_column_id FROM boards WHERE id = ?',
    boardId,
  )
  return {
    review: row?.review_column_id ? getColumn(row.review_column_id) : null,
    done: row?.done_column_id ? getColumn(row.done_column_id) : null,
  }
}

export function createColumn(boardId: string, input: CreateColumnInput): Column {
  touchBoard(boardId)
  const id = newId()
  const ids = listColumns(boardId).map((column) => column.id)
  sql.run(
    'INSERT INTO columns (id, board_id, name, color, wip_limit, position) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    boardId,
    input.name,
    input.color ?? 'gray',
    input.wipLimit ?? null,
    ids.length,
  )
  if (input.position !== undefined) moveColumn(id, input.position)
  return getColumn(id)
}

export function updateColumn(id: string, input: UpdateColumnInput): Column {
  const column = getColumn(id)
  touchBoard(column.boardId)
  updateRow('columns', id, { name: input.name, color: input.color, wip_limit: input.wipLimit })
  return getColumn(id)
}

export function moveColumn(id: string, position: number): Column {
  const column = getColumn(id)
  touchBoard(column.boardId)
  const ids = listColumns(column.boardId)
    .map((other) => other.id)
    .filter((otherId) => otherId !== id)
  ids.splice(position, 0, id)
  reorder('columns', ids)
  return getColumn(id)
}

/** Deletes a column along with any tickets still in it. */
export function deleteColumn(id: string) {
  const column = getColumn(id)
  touchBoard(column.boardId)
  sql.run('DELETE FROM columns WHERE id = ?', id)
  reorder(
    'columns',
    listColumns(column.boardId).map((other) => other.id),
  )
}
