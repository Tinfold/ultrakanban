import { CLAUDE_USAGE_FRESH_MINUTES, type ClaudeUsage, type ClaudeUsageLimit, reserveFor } from '../../shared/domain.ts'
import type { ReportClaudeUsageInput, SetUsageReserveInput } from '../../shared/schemas.ts'
import { now, sql } from '../db.ts'

interface ClaudeUsageRow {
  reported_at: string | null
  plan: string | null
  limits: string
  error: string | null
  week_reserve_percent: number | null
  session_reserve_percent: number | null
}

/** When a limit resets; never for one that isn't running (no reset time). */
const resetTime = (limit: ClaudeUsageLimit) => (limit.resetsAt === null ? Infinity : Date.parse(limit.resetsAt))

/** Whether the limit `a` lifts after `b`: it resets later, or at the same time and is more used. */
const liftsAfter = (a: ClaudeUsageLimit, b: ClaudeUsageLimit) =>
  resetTime(a) > resetTime(b) || (resetTime(a) === resetTime(b) && a.percent > b.percent)

/**
 * The limit that holds agents back with the usage reserve at `at` (see `ClaudeUsage.reserveReached`): of the limits at
 * or over their reserve that haven't reset since the report, the one that lifts last, when the report is fresh. A
 * stale or missing report never holds them back, so agents don't stop with a supervisor that did.
 */
export function reserveReached(
  { reportedAt, limits, reserve }: Pick<ClaudeUsage, 'reportedAt' | 'limits' | 'reserve'>,
  at = Date.now(),
): ClaudeUsageLimit | null {
  if (!reportedAt || Date.parse(reportedAt) < at - CLAUDE_USAGE_FRESH_MINUTES * 60_000) return null
  const reached = limits.filter((limit) => {
    const percent = reserveFor(limit, reserve)
    // Past its reset time a limit starts again from nothing, even before the next report says so.
    const running = limit.resetsAt === null || Date.parse(limit.resetsAt) > at
    return percent !== null && running && limit.percent >= percent
  })
  return reached.reduce<ClaudeUsageLimit | null>(
    (last, limit) => (last === null || liftsAfter(limit, last) ? limit : last),
    null,
  )
}

function toClaudeUsage(row: ClaudeUsageRow): ClaudeUsage {
  const usage = {
    reportedAt: row.reported_at,
    plan: row.plan,
    limits: JSON.parse(row.limits) as ClaudeUsageLimit[],
    error: row.error,
    reserve: { week: row.week_reserve_percent, session: row.session_reserve_percent },
  }
  return { ...usage, reserveReached: reserveReached(usage) }
}

export const getClaudeUsage = () => toClaudeUsage(sql.get<ClaudeUsageRow>('SELECT * FROM claude_usage WHERE id = 1')!)

/** Sets the usage reserve of the week, the current session or both (see `ClaudeUsageReserve`); null switches it off. */
export function setUsageReserve({ week, session }: SetUsageReserveInput): ClaudeUsage {
  const current = getClaudeUsage().reserve
  sql.run(
    'UPDATE claude_usage SET week_reserve_percent = ?, session_reserve_percent = ? WHERE id = 1',
    week === undefined ? current.week : week,
    session === undefined ? current.session : session,
  )
  return getClaudeUsage()
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function toLimit(label: string, percent: unknown, resetsAt: unknown): ClaudeUsageLimit[] {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return []
  return [
    {
      label,
      percent: Math.min(100, Math.max(0, percent)),
      resetsAt: typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt)) ? resetsAt : null,
    },
  ]
}

/** The older fields of the usage endpoint, for when its answer has no `limits` list. */
const WINDOWS = [
  ['five_hour', 'Current session'],
  ['seven_day', 'Week, all models'],
  ['seven_day_opus', 'Week, Opus'],
  ['seven_day_sonnet', 'Week, Sonnet'],
] as const

/**
 * The limits in an answer of Claude's usage endpoint (`/api/oauth/usage`, what `/usage` in Claude Code shows). It
 * isn't a documented API, so anything that doesn't look as expected is left out rather than rejected.
 */
export function parseClaudeUsage(usage: Record<string, unknown>): ClaudeUsageLimit[] {
  if (Array.isArray(usage.limits)) {
    return usage.limits.filter(isObject).flatMap((limit) => {
      let label: string
      if (limit.kind === 'session') label = 'Current session'
      else if (limit.kind === 'weekly_all') label = 'Week, all models'
      else {
        const scope = isObject(limit.scope) ? limit.scope : {}
        const model = isObject(scope.model) && typeof scope.model.display_name === 'string' && scope.model.display_name
        label = model ? `Week, ${model}` : typeof limit.kind === 'string' ? limit.kind.replaceAll('_', ' ') : 'Limit'
      }
      return toLimit(label, limit.percent, limit.resets_at)
    })
  }
  return WINDOWS.flatMap(([key, label]) => {
    const window = usage[key]
    return isObject(window) ? toLimit(label, window.utilization, window.resets_at) : []
  })
}

/** Records what the supervisor read; a report with neither usage nor an error only updates the plan and the time. */
export function reportClaudeUsage(input: ReportClaudeUsageInput): ClaudeUsage {
  const current = getClaudeUsage()
  const limits = input.usage ? parseClaudeUsage(input.usage) : input.error ? [] : current.limits
  sql.run(
    'UPDATE claude_usage SET reported_at = ?, plan = ?, limits = ?, error = ? WHERE id = 1',
    now(),
    input.plan === undefined ? current.plan : input.plan,
    JSON.stringify(limits),
    input.usage ? null : (input.error ?? current.error),
  )
  return getClaudeUsage()
}
