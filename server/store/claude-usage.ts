import type { ClaudeUsage, ClaudeUsageLimit } from '../../shared/domain.ts'
import type { ReportClaudeUsageInput } from '../../shared/schemas.ts'
import { now, sql } from '../db.ts'

interface ClaudeUsageRow {
  reported_at: string | null
  plan: string | null
  limits: string
  error: string | null
}

const toClaudeUsage = (row: ClaudeUsageRow): ClaudeUsage => ({
  reportedAt: row.reported_at,
  plan: row.plan,
  limits: JSON.parse(row.limits) as ClaudeUsageLimit[],
  error: row.error,
})

export const getClaudeUsage = () => toClaudeUsage(sql.get<ClaudeUsageRow>('SELECT * FROM claude_usage WHERE id = 1')!)

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
