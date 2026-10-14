import type { AgentServices } from '@shared/domain'

/**
 * The supervisor reports once a poll: every 30 seconds by default, less often with a longer POLL_SECONDS or while it
 * updates. After this long without a report, it is taken to be down, so nothing starts or stops the agents.
 */
export const SUPERVISOR_OFFLINE_MS = 3 * 60_000

/** Switched off or on, and the supervisor hasn't seen to it yet. */
export const agentsSwitching = ({ changedAt, handledAt, reportedAt }: AgentServices) =>
  !!changedAt && !!reportedAt && changedAt !== handledAt

/**
 * What the header's agents button shows, in this order: the supervisor hasn't reported for a while (`offline`), a switch
 * it hasn't seen to yet (`switching`), switched off (`paused`), boards whose loop isn't running (`missing`, by name),
 * or all of them running (`up`). `serverNow` is the server's time now, since `reportedAt` is by its clock.
 */
export type AgentsSwitchState =
  | { kind: 'offline' }
  | { kind: 'switching'; paused: boolean }
  | { kind: 'paused' }
  | { kind: 'missing'; boards: string[] }
  | { kind: 'up'; boards: number }

export function agentsSwitchState(
  services: AgentServices,
  serverNow: number,
  boardName: (id: string) => string | undefined,
): AgentsSwitchState {
  if (!services.reportedAt || serverNow - Date.parse(services.reportedAt) > SUPERVISOR_OFFLINE_MS) {
    return { kind: 'offline' }
  }
  if (agentsSwitching(services)) return { kind: 'switching', paused: services.paused }
  if (services.paused) return { kind: 'paused' }
  const missing = services.wanted.filter((id) => !services.running.includes(id))
  if (missing.length) return { kind: 'missing', boards: missing.map((id) => boardName(id) ?? id) }
  return { kind: 'up', boards: services.wanted.length }
}
