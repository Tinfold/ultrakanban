import type { AgentClaimError, AgentServices } from '../../shared/domain.ts'
import type { ReportAgentServicesInput } from '../../shared/schemas.ts'
import { now, sql } from '../db.ts'

interface AgentServicesRow {
  agents_paused: number
  agents_restart: number
  agents_changed_at: string | null
  agents_changed_by: string | null
  agents_running: string | null
  agents_reported_at: string | null
  agents_handled_at: string | null
}

export function getAgentServices(): AgentServices {
  const row = sql.get<AgentServicesRow>(
    `SELECT agents_paused, agents_restart, agents_changed_at, agents_changed_by, agents_running, agents_reported_at, agents_handled_at
     FROM setup WHERE id = 1`,
  )!
  const wanted = sql.all<{ id: string }>(
    'SELECT id FROM boards WHERE agent_enabled = 1 AND github_repo IS NOT NULL ORDER BY id',
  )
  const claimErrors = sql.all<AgentClaimError>(
    `SELECT id AS boardId, claim_error AS message, claim_error_at AS since FROM boards
     WHERE claim_error IS NOT NULL ORDER BY id`,
  )
  return {
    paused: row.agents_paused === 1,
    restart: row.agents_restart === 1,
    changedAt: row.agents_changed_at,
    changedBy: row.agents_changed_by,
    wanted: wanted.map(({ id }) => id),
    running: row.agents_running ? (JSON.parse(row.agents_running) as string[]) : [],
    claimErrors,
    reportedAt: row.agents_reported_at,
    handledAt: row.agents_handled_at,
    serverTime: now(),
  }
}

/**
 * Switches every board's agents off, or on again (restarting the loops that run, with `restart`); the supervisor stops
 * or starts their loops on its next look.
 */
export function setAgentsPaused(paused: boolean, actor: string, restart = false): AgentServices {
  sql.run(
    'UPDATE setup SET agents_paused = ?, agents_restart = ?, agents_changed_at = ?, agents_changed_by = ? WHERE id = 1',
    Number(paused),
    Number(!paused && restart),
    now(),
    actor,
  )
  return getAgentServices()
}

/** The supervisor reporting the boards whose loop runs, and the switch it saw to, after starting and stopping loops. */
export function reportAgentServices(input: ReportAgentServicesInput): AgentServices {
  sql.run(
    'UPDATE setup SET agents_running = ?, agents_reported_at = ?, agents_handled_at = ? WHERE id = 1',
    JSON.stringify([...new Set(input.running)].sort()),
    now(),
    input.handledAt ?? null,
  )
  // A stopped loop claims nothing, so why its claims failed no longer says anything: started again, it tries afresh.
  sql.run(
    `UPDATE boards SET claim_error = NULL, claim_error_at = NULL
     WHERE claim_error IS NOT NULL AND id NOT IN (SELECT value FROM json_each(?))`,
    JSON.stringify(input.running),
  )
  return getAgentServices()
}

/**
 * Notes how claiming a ticket on a board went: why it failed, or null when it went through or found nothing to do. A
 * failure keeps the time it first failed that way, so a loop retrying every minute doesn't write each time.
 */
export function recordClaim(boardId: string, error: string | null) {
  sql.run(
    `UPDATE boards SET claim_error = ?, claim_error_at = CASE WHEN ? IS NULL THEN NULL ELSE ? END
     WHERE id = ? AND claim_error IS NOT ?`,
    error,
    error,
    now(),
    boardId,
    error,
  )
}
