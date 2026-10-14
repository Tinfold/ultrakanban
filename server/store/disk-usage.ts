import {
  type AgentDiskUsage,
  type AttachmentBytes,
  type AttachmentCleanup,
  type BoardDiskBreakdown,
  CANCELLED_COLUMN,
  DISK_USAGE_TICKETS,
  type TicketAttachmentBytes,
} from '../../shared/domain.ts'
import type { AttachmentCleanupInput, ReportDiskUsageInput } from '../../shared/schemas.ts'
import { now, sql, touchBoard } from '../db.ts'
import { getBoard } from './boards.ts'

interface AgentDiskUsageRow {
  board_id: string
  repo: number
  worktrees: number
  state: number
  measured_at: string
}

/** The agent folders' disk space by board id, including boards deleted since it was measured. */
export const agentDiskUsage = () =>
  new Map(
    sql
      .all<AgentDiskUsageRow>('SELECT * FROM agent_disk_usage')
      .map((row): [string, AgentDiskUsage] => [
        row.board_id,
        { repo: row.repo, worktrees: row.worktrees, state: row.state, measuredAt: row.measured_at },
      ]),
  )

/** The bytes of each board's attachments, by board id. */
export const attachmentBytes = () =>
  new Map(
    sql
      .all<{ board_id: string; bytes: number }>(
        `SELECT t.board_id, sum(a.size) AS bytes FROM attachments a JOIN tickets t ON t.id = a.ticket_id
         GROUP BY t.board_id`,
      )
      .map((row) => [row.board_id, row.bytes]),
  )

/** Whether the ticket `t` is finished: in its board's done column (its last column if it has none) or Cancelled. */
const TICKET_FINISHED = `
  (t.column_id = coalesce(
    (SELECT done_column_id FROM boards WHERE id = t.board_id),
    (SELECT id FROM columns WHERE board_id = t.board_id ORDER BY position DESC LIMIT 1))
  OR t.column_id IN (SELECT id FROM columns WHERE board_id = t.board_id AND lower(name) = '${CANCELLED_COLUMN}'))`

const attachmentBytesWhere = (where: string, ...params: string[]): AttachmentBytes =>
  sql.get<AttachmentBytes>(
    `SELECT count(*) AS count, coalesce(sum(a.size), 0) AS bytes
     FROM attachments a JOIN tickets t ON t.id = a.ticket_id WHERE ${where}`,
    ...params,
  ) ?? { count: 0, bytes: 0 }

/** What the board's disk space is made of: its attachments by kind and ticket, and its agent folder. */
export function boardDiskBreakdown(boardId: string): BoardDiskBreakdown {
  const { id } = getBoard(boardId)
  const tickets = sql
    .all<{ id: string; number: number; title: string; finished: number; count: number; bytes: number }>(
      `SELECT t.id, t.number, t.title, ${TICKET_FINISHED} AS finished, count(*) AS count, sum(a.size) AS bytes
       FROM attachments a JOIN tickets t ON t.id = a.ticket_id WHERE t.board_id = ?
       GROUP BY t.id ORDER BY bytes DESC, t.number LIMIT ?`,
      id,
      DISK_USAGE_TICKETS,
    )
    .map((row): TicketAttachmentBytes => ({
      ticketId: row.id,
      number: row.number,
      title: row.title,
      finished: row.finished === 1,
      count: row.count,
      bytes: row.bytes,
    }))
  return {
    attachments: {
      images: attachmentBytesWhere(`t.board_id = ? AND a.content_type LIKE 'image/%'`, id),
      videos: attachmentBytesWhere(`t.board_id = ? AND a.content_type LIKE 'video/%'`, id),
      finished: attachmentBytesWhere(`t.board_id = ? AND ${TICKET_FINISHED}`, id),
      tickets,
    },
    agent: agentDiskUsage().get(id) ?? null,
  }
}

/**
 * Deletes the attachments of the board's finished tickets, only those uploaded more than `olderThanDays` ago if given.
 * Their files are left for the caller to sweep.
 */
export function cleanUpAttachments(boardId: string, { olderThanDays }: AttachmentCleanupInput): AttachmentCleanup {
  const { id } = getBoard(boardId)
  const params = [id]
  let where = `t.board_id = ? AND ${TICKET_FINISHED}`
  if (olderThanDays) {
    where += ' AND a.created_at < ?'
    params.push(new Date(Date.now() - olderThanDays * 86_400_000).toISOString())
  }
  const deleted = attachmentBytesWhere(where, ...params)
  if (deleted.count) {
    sql.run(
      `DELETE FROM attachments WHERE id IN (SELECT a.id FROM attachments a JOIN tickets t ON t.id = a.ticket_id
       WHERE ${where})`,
      ...params,
    )
    touchBoard(id)
  }
  return deleted
}

/** Asks the board's agent loops to clear their checkouts' build output (see `agentCleanupRequestedAt`). */
export function requestAgentCleanup(boardId: string) {
  const { id } = getBoard(boardId)
  sql.run('UPDATE boards SET agent_cleanup_requested_at = ? WHERE id = ?', now(), id)
  touchBoard(id)
  return getBoard(id)
}

/** Replaces the last measurement: a folder the supervisor no longer reports is gone. */
export function reportDiskUsage(input: ReportDiskUsageInput) {
  const measuredAt = now()
  sql.run('DELETE FROM agent_disk_usage')
  for (const board of input.boards) {
    sql.run(
      'INSERT OR REPLACE INTO agent_disk_usage (board_id, repo, worktrees, state, measured_at) VALUES (?, ?, ?, ?, ?)',
      board.boardId,
      board.repo,
      board.worktrees,
      board.state,
      measuredAt,
    )
  }
}
