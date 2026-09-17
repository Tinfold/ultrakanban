import { type Color, colorForName, type Tag } from '../../shared/domain.ts'
import type { CreateTagInput, UpdateTagInput } from '../../shared/schemas.ts'
import { newId, sql, touchBoard, updateRow } from '../db.ts'
import { conflict, notFound } from '../errors.ts'

interface TagRow {
  id: string
  board_id: string
  name: string
  color: string
}

const toTag = (row: TagRow): Tag => ({ id: row.id, boardId: row.board_id, name: row.name, color: row.color as Color })

export function listTags(boardId: string): Tag[] {
  return sql.all<TagRow>('SELECT * FROM tags WHERE board_id = ? ORDER BY name', boardId).map(toTag)
}

export function getTag(id: string): Tag {
  const row = sql.get<TagRow>('SELECT * FROM tags WHERE id = ?', id)
  if (!row) throw notFound('Tag', id)
  return toTag(row)
}

function findTag(boardId: string, ref: string): Tag | undefined {
  const row = sql.get<TagRow>(
    'SELECT * FROM tags WHERE board_id = ? AND (id = ? OR name = ?) ORDER BY id = ? DESC LIMIT 1',
    boardId,
    ref,
    ref,
    ref,
  )
  return row && toTag(row)
}

function assertNameAvailable(boardId: string, name: string, exceptId?: string) {
  const existing = sql.get<TagRow>('SELECT * FROM tags WHERE board_id = ? AND name = ?', boardId, name)
  if (existing && existing.id !== exceptId) {
    throw conflict('tag_exists', `Tag "${existing.name}" already exists`, { tag: toTag(existing) })
  }
}

export function createTag(boardId: string, input: CreateTagInput): Tag {
  touchBoard(boardId)
  assertNameAvailable(boardId, input.name)
  const id = newId()
  sql.run(
    'INSERT INTO tags (id, board_id, name, color) VALUES (?, ?, ?, ?)',
    id,
    boardId,
    input.name,
    input.color ?? colorForName(input.name),
  )
  return getTag(id)
}

export function updateTag(id: string, input: UpdateTagInput): Tag {
  const tag = getTag(id)
  touchBoard(tag.boardId)
  if (input.name) assertNameAvailable(tag.boardId, input.name, id)
  updateRow('tags', id, { name: input.name, color: input.color })
  return getTag(id)
}

export function deleteTag(id: string) {
  const tag = getTag(id)
  touchBoard(tag.boardId)
  sql.run('DELETE FROM tags WHERE id = ?', id)
}

/** Resolves tag ids or names to ids. Unknown names are created when `create` is set. */
export function resolveTags(boardId: string, refs: string[], { create }: { create: boolean }): string[] {
  const ids = refs.map((ref) => {
    const tag = findTag(boardId, ref)
    if (tag) return tag.id
    if (!create) throw notFound('Tag', ref)
    return createTag(boardId, { name: ref }).id
  })
  return [...new Set(ids)]
}
