import type { AgentServices } from '../../shared/domain.ts'
import type { ReportAgentServicesInput } from '../../shared/schemas.ts'
import { now, sql } from '../db.ts'

interface AgentServicesRow {
  agents_paused: number
  agents_changed_at: string | null
  agents_changed_by: string | null
  agents_running: string | null
  agents_reported_at: string | null
  agents_handled_at: string | null
}

export function getAgentServices(): AgentServices {
  const row = sql.get<AgentServicesRow>(
    `SELECT agents_paused, agents_changed_at, agents_changed_by, agents_running, agents_reported_at, agents_handled_at
     FROM setup WHERE id = 1`,
  )!
  const wanted = sql.all<{ id: string }>(
    'SELECT id FROM boards WHERE agent_enabled = 1 AND github_repo IS NOT NULL ORDER BY id',
  )
  return {
    paused: row.agents_paused === 1,
    changedAt: row.agents_changed_at,
    changedBy: row.agents_changed_by,
    wanted: wanted.map(({ id }) => id),
    running: row.agents_running ? (JSON.parse(row.agents_running) as string[]) : [],
    reportedAt: row.agents_reported_at,
    handledAt: row.agents_handled_at,
    serverTime: now(),
  }
}

/** Switches every board's agents off, or on again; the supervisor stops or starts their loops on its next look. */
export function setAgentsPaused(paused: boolean, actor: string): AgentServices {
  sql.run(
    'UPDATE setup SET agents_paused = ?, agents_changed_at = ?, agents_changed_by = ? WHERE id = 1',
    Number(paused),
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
  return getAgentServices()
}
