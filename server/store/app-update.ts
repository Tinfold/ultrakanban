import type { AppUpdate, AppUpdateState } from '../../shared/domain.ts'
import type { ReportAppUpdateInput } from '../../shared/schemas.ts'
import { now, sql } from '../db.ts'
import { conflict } from '../errors.ts'

interface AppUpdateRow {
  state: AppUpdateState
  requested_at: string | null
  requested_by: string | null
  finished_at: string | null
  message: string | null
  updater_seen_at: string | null
  version: string | null
  behind: number | null
}

const toAppUpdate = (row: AppUpdateRow): AppUpdate => ({
  state: row.state,
  requestedAt: row.requested_at,
  requestedBy: row.requested_by,
  finishedAt: row.finished_at,
  message: row.message,
  updaterSeenAt: row.updater_seen_at,
  version: row.version,
  behind: row.behind,
})

export const getAppUpdate = () => toAppUpdate(sql.get<AppUpdateRow>('SELECT * FROM app_update WHERE id = 1')!)

/** Asks the agent supervisor to update and restart ultrakanban; one update at a time. */
export function requestAppUpdate(actor: string): AppUpdate {
  const { state } = getAppUpdate()
  if (state === 'requested' || state === 'running') {
    throw conflict('update_in_progress', 'An update has already been asked for')
  }
  sql.run(
    "UPDATE app_update SET state = 'requested', requested_at = ?, requested_by = ?, message = NULL WHERE id = 1",
    now(),
    actor,
  )
  return getAppUpdate()
}

/** Withdraws a request the supervisor hasn't picked up yet. */
export function cancelAppUpdate(): AppUpdate {
  const { state } = getAppUpdate()
  if (state === 'running') throw conflict('update_running', 'The update is already running')
  if (state === 'requested') sql.run("UPDATE app_update SET state = 'idle' WHERE id = 1")
  return getAppUpdate()
}

/**
 * The supervisor checking in, with the checkout's version and how far behind it is, and reporting on an update:
 * `running` takes a request (409 `update_not_requested` when there is none, e.g. it was withdrawn meanwhile),
 * `done` and `failed` finish one.
 */
export function reportAppUpdate(input: ReportAppUpdateInput): AppUpdate {
  const current = getAppUpdate()
  const time = now()
  let { state, finishedAt, message } = current
  if (input.state === 'running') {
    if (current.state !== 'requested') throw conflict('update_not_requested', 'No update has been asked for')
    state = 'running'
    message = input.message ?? null
  } else if (input.state) {
    state = input.state
    finishedAt = time
    message = input.message ?? null
  }
  sql.run(
    `UPDATE app_update SET state = ?, finished_at = ?, message = ?, updater_seen_at = ?, version = ?, behind = ?
     WHERE id = 1`,
    state,
    finishedAt,
    message,
    time,
    input.version === undefined ? current.version : input.version,
    input.behind === undefined ? current.behind : input.behind,
  )
  return getAppUpdate()
}
