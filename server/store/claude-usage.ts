import {
  CLAUDE_USAGE_FRESH_MINUTES,
  type ClaudeUsage,
  type ClaudeUsageLimit,
  isWeeklyLimit,
} from '../../shared/domain.ts'
import type { ReportClaudeUsageInput } from '../../shared/schemas.ts'
import { now, sql } from '../db.ts'

interface ClaudeUsageRow {
  reported_at: string | null
  plan: string | null
  limits: string
  error: string | null
  reserve_percent: number | null
}

/**
 * The weekly limit that holds agents back with the usage reserve at `at` (see `ClaudeUsage.reserveReached`): the most
 * used of the weekly limits that haven't reset since the report, when the report is fresh and that one is at or over
 * the reserve. A stale or missing report never holds them back, so agents don't stop with a supervisor that did.
 */
export function reserveReached(
  { reportedAt, limits, reservePercent }: Pick<ClaudeUsage, 'reportedAt' | 'limits' | 'reservePercent'>,
  at = Date.now(),
): ClaudeUsageLimit | null {
  if (reservePercent === null || !reportedAt) return null
  if (Date.parse(reportedAt) < at - CLAUDE_USAGE_FRESH_MINUTES * 60_000) return null
  // Past its reset time a limit starts again from nothing, even before the next report says so.
  const running = limits.filter(
    (limit) => isWeeklyLimit(limit) && (limit.resetsAt === null || Date.parse(limit.resetsAt) > at),
  )
  const most = running.reduce<ClaudeUsageLimit | null>(
    (highest, limit) => (highest === null || limit.percent > highest.percent ? limit : highest),
    null,
  )
  return most && most.percent >= reservePercent ? most : null
}

function toClaudeUsage(row: ClaudeUsageRow): ClaudeUsage {
  const usage = {
    reportedAt: row.reported_at,
    plan: row.plan,
    limits: JSON.parse(row.limits) as ClaudeUsageLimit[],
    error: row.error,
    reservePercent: row.reserve_percent,
  }
  return { ...usage, reserveReached: reserveReached(usage) }
}

export const getClaudeUsage = () => toClaudeUsage(sql.get<ClaudeUsageRow>('SELECT * FROM claude_usage WHERE id = 1')!)

/** Sets the usage reserve (see `ClaudeUsage.reservePercent`); null switches it off. */
export function setUsageReserve(reservePercent: number | null): ClaudeUsage {
  sql.run('UPDATE claude_usage SET reserve_percent = ? WHERE id = 1', reservePercent)
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
