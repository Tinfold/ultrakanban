import type { AutoMergeWait } from '../../shared/domain.ts'
import { now, sql } from '../db.ts'
import { publish } from '../events.ts'

/** What auto-merge found about one ticket's pull request (see `AutoMergeWait`); null when it is ready. */
export type AutoMergeFinding = Pick<AutoMergeWait, 'reason' | 'failed'> | null

interface WaitRow {
  id: string
  auto_merge_wait: string
  auto_merge_failed: number
  auto_merge_since: string | null
}

/**
 * Records why the board's auto-merge isn't merging each ticket in `findings`, and forgets it for the board's other
 * tickets (those that left the review column, or whose pull request was merged or closed). A reason that stays the
 * same keeps its `since`. Not a change to the tickets: nothing is logged or bumped, like heartbeats, but the board is
 * told when anything changed, so it shows.
 */
export function setAutoMergeWaits(boardId: string, findings: Map<string, AutoMergeFinding>) {
  const stored = new Map(
    sql
      .all<WaitRow>(
        'SELECT id, auto_merge_wait, auto_merge_failed, auto_merge_since FROM tickets WHERE board_id = ? AND auto_merge_wait IS NOT NULL',
        boardId,
      )
      .map((row) => [row.id, row]),
  )
  const at = now()
  let changed = false
  for (const id of stored.keys()) {
    if (findings.get(id)) continue
    sql.run(
      'UPDATE tickets SET auto_merge_wait = NULL, auto_merge_failed = 0, auto_merge_since = NULL WHERE id = ?',
      id,
    )
    changed = true
  }
  for (const [id, finding] of findings) {
    const row = stored.get(id)
    if (!finding || (row?.auto_merge_wait === finding.reason && Boolean(row.auto_merge_failed) === finding.failed)) {
      continue
    }
    sql.run(
      'UPDATE tickets SET auto_merge_wait = ?, auto_merge_failed = ?, auto_merge_since = ? WHERE id = ? AND board_id = ?',
      finding.reason,
      Number(finding.failed),
      row?.auto_merge_wait === finding.reason ? (row.auto_merge_since ?? at) : at,
      id,
      boardId,
    )
    changed = true
  }
  if (changed) publish({ boardId })
}
