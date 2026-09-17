import type { Attachment, AttachmentType } from '../../shared/domain.ts'
import { now, sql, touchBoard } from '../db.ts'
import { notFound } from '../errors.ts'
import { logActivity } from './activity.ts'
import { getTicket } from './tickets.ts'

interface AttachmentRow {
  id: string
  ticket_id: string
  filename: string
  content_type: string
  size: number
  actor: string
  created_at: string
}

const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  ticketId: row.ticket_id,
  filename: row.filename,
  contentType: row.content_type as AttachmentType,
  size: row.size,
  actor: row.actor,
  createdAt: row.created_at,
  url: `/api/attachments/${row.id}`,
})

export function listAttachments(ticketId: string): Attachment[] {
  getTicket(ticketId)
  return sql
    .all<AttachmentRow>('SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at', ticketId)
    .map(toAttachment)
}

export function getAttachment(id: string): Attachment {
  const row = sql.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id)
  if (!row) throw notFound('Attachment', id)
  return toAttachment(row)
}

export const listAttachmentIds = () =>
  new Set(sql.all<{ id: string }>('SELECT id FROM attachments').map((row) => row.id))

export interface NewAttachment {
  id: string
  filename: string
  contentType: AttachmentType
  size: number
}

export function createAttachment(ticketId: string, file: NewAttachment, actor: string): Attachment {
  const ticket = getTicket(ticketId)
  touchBoard(ticket.boardId)
  sql.run(
    `INSERT INTO attachments (id, ticket_id, filename, content_type, size, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    file.id,
    ticketId,
    file.filename,
    file.contentType,
    file.size,
    actor,
    now(),
  )
  logActivity(ticketId, actor, 'attachment', {
    attachmentId: file.id,
    filename: file.filename,
    contentType: file.contentType,
  })
  return getAttachment(file.id)
}

export function deleteAttachment(id: string) {
  const attachment = getAttachment(id)
  touchBoard(getTicket(attachment.ticketId).boardId)
  sql.run('DELETE FROM attachments WHERE id = ?', id)
}
