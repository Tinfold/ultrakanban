import type { AgentDiskUsage } from '../../shared/domain.ts'
import type { ReportDiskUsageInput } from '../../shared/schemas.ts'
import { now, sql } from '../db.ts'

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
