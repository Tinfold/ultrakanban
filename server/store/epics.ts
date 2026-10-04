import { CANCELLED_COLUMN, type Color, colorForName, type Epic } from '../../shared/domain.ts'
import type { CreateEpicInput, UpdateEpicInput } from '../../shared/schemas.ts'
import { newId, now, sql, touchBoard, updateRow } from '../db.ts'
import { conflict, notFound } from '../errors.ts'

interface EpicRow {
  id: string
  board_id: string
  title: string
  description: string
  color: string
  created_at: string
  updated_at: string
  total: number
  done: number
}

/** Tickets of the epic `e` that count towards its progress: all but cancelled ones. Aliased `t`. */
const EPIC_TICKETS = `
  FROM tickets t
  WHERE t.epic_id = e.id
    AND t.column_id NOT IN (SELECT id FROM columns WHERE board_id = e.board_id AND lower(name) = '${CANCELLED_COLUMN}')`

/** Whether the ticket `t` is finished: merged, or in the board's done column (its last column if it has none). */
const TICKET_DONE = `
  (t.pr_state = 'merged' OR t.column_id = coalesce(
    (SELECT done_column_id FROM boards WHERE id = e.board_id),
    (SELECT id FROM columns WHERE board_id = e.board_id ORDER BY position DESC LIMIT 1)))`

const SELECT_EPICS = `
  SELECT e.*,
    (SELECT count(*) ${EPIC_TICKETS}) AS total,
    (SELECT count(*) ${EPIC_TICKETS} AND ${TICKET_DONE}) AS done
  FROM epics e`

const toEpic = (row: EpicRow): Epic => ({
  id: row.id,
  boardId: row.board_id,
  title: row.title,
  description: row.description,
  color: row.color as Color,
  progress: { done: row.done, total: row.total },
  done: row.total > 0 && row.done === row.total,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export function listEpics(boardId: string): Epic[] {
  return sql.all<EpicRow>(`${SELECT_EPICS} WHERE e.board_id = ? ORDER BY e.created_at, e.rowid`, boardId).map(toEpic)
}

export function getEpic(id: string): Epic {
  const row = sql.get<EpicRow>(`${SELECT_EPICS} WHERE e.id = ?`, id)
  if (!row) throw notFound('Epic', id)
  return toEpic(row)
}

function findEpic(boardId: string, ref: string): Epic | undefined {
  const row = sql.get<EpicRow>(
    `${SELECT_EPICS} WHERE e.board_id = ? AND (e.id = ? OR e.title = ?) ORDER BY e.id = ? DESC LIMIT 1`,
    boardId,
    ref,
    ref,
    ref,
  )
  return row && toEpic(row)
}

function assertTitleAvailable(boardId: string, title: string, exceptId?: string) {
  const existing = sql.get<EpicRow>(`${SELECT_EPICS} WHERE e.board_id = ? AND e.title = ?`, boardId, title)
  if (existing && existing.id !== exceptId) {
    throw conflict('epic_exists', `Epic "${existing.title}" already exists`, { epic: toEpic(existing) })
  }
}

export function createEpic(boardId: string, input: CreateEpicInput): Epic {
  touchBoard(boardId)
  assertTitleAvailable(boardId, input.title)
  const id = newId()
  const time = now()
  sql.run(
    'INSERT INTO epics (id, board_id, title, description, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    boardId,
    input.title,
    input.description ?? '',
    input.color ?? colorForName(input.title),
    time,
    time,
  )
  return getEpic(id)
}

export function updateEpic(id: string, input: UpdateEpicInput): Epic {
  const epic = getEpic(id)
  touchBoard(epic.boardId)
  if (input.title) assertTitleAvailable(epic.boardId, input.title, id)
  updateRow('epics', id, { title: input.title, description: input.description, color: input.color, updated_at: now() })
  return getEpic(id)
}

/** Deletes an epic; its tickets stay, in no epic. */
export function deleteEpic(id: string) {
  const epic = getEpic(id)
  touchBoard(epic.boardId)
  sql.run('DELETE FROM epics WHERE id = ?', id)
}

/**
 * Resolves an epic's id or title to its id, or null for no epic. An unknown title creates the epic when `create` is
 * set.
 */
export function resolveEpic(boardId: string, ref: string | null, { create }: { create: boolean }): string | null {
  if (ref === null) return null
  const epic = findEpic(boardId, ref)
  if (epic) return epic.id
  if (!create) throw notFound('Epic', ref)
  return createEpic(boardId, { title: ref }).id
}
