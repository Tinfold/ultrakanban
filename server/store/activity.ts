import type { Activity, ActivityType } from '../../shared/domain.ts'
import { now, sql } from '../db.ts'

interface ActivityRow {
  id: number
  ticket_id: string
  actor: string
  type: string
  data: string
  created_at: string
}

type ActivityData<T extends ActivityType> = Extract<Activity, { type: T }>['data']

/** Consecutive edits by the same actor within this window are merged into one entry. */
const MERGE_WINDOW_MS = 10 * 60 * 1000

const toActivity = (row: ActivityRow) =>
  ({
    id: row.id,
    ticketId: row.ticket_id,
    actor: row.actor,
    type: row.type,
    data: JSON.parse(row.data),
    createdAt: row.created_at,
  }) as Activity

export function listActivity(ticketId: string): Activity[] {
  return sql.all<ActivityRow>('SELECT * FROM activity WHERE ticket_id = ? ORDER BY id', ticketId).map(toActivity)
}

export function logActivity<T extends ActivityType>(
  ticketId: string,
  actor: string,
  type: T,
  data: ActivityData<T>,
  createdAt = now(),
): Activity {
  if (type === 'updated' && mergeUpdate(ticketId, actor, data as ActivityData<'updated'>, createdAt)) {
    return lastActivity(ticketId)!
  }
  const { lastInsertRowid } = sql.run(
    'INSERT INTO activity (ticket_id, actor, type, data, created_at) VALUES (?, ?, ?, ?, ?)',
    ticketId,
    actor,
    type,
    JSON.stringify(data),
    createdAt,
  )
  return toActivity(sql.get<ActivityRow>('SELECT * FROM activity WHERE id = ?', lastInsertRowid)!)
}

function lastActivity(ticketId: string): Activity | undefined {
  const row = sql.get<ActivityRow>('SELECT * FROM activity WHERE ticket_id = ? ORDER BY id DESC LIMIT 1', ticketId)
  return row && toActivity(row)
}

function mergeUpdate(ticketId: string, actor: string, data: ActivityData<'updated'>, createdAt: string) {
  const last = lastActivity(ticketId)
  if (last?.type !== 'updated' || last.actor !== actor) return false
  if (Date.parse(createdAt) - Date.parse(last.createdAt) > MERGE_WINDOW_MS) return false
  const fields = [...new Set([...last.data.fields, ...data.fields])]
  sql.run('UPDATE activity SET data = ?, created_at = ? WHERE id = ?', JSON.stringify({ fields }), createdAt, last.id)
  return true
}
