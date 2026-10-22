import {
  type AgentApiKey,
  CLAUDE_USAGE_FRESH_MINUTES,
  type ClaudeUsage,
  type ClaudeUsageCredit,
  type ClaudeUsageLimit,
  reserveFor,
} from '../../shared/domain.ts'
import type { ReportClaudeUsageInput, SetAgentApiKeyInput, SetUsageReserveInput } from '../../shared/schemas.ts'
import { now, sql } from '../db.ts'

interface ClaudeUsageRow {
  reported_at: string | null
  plan: string | null
  limits: string
  credits: string
  error: string | null
  week_reserve_percent: number | null
  session_reserve_percent: number | null
  usage_credits: number
  api_key_fallback: number
  api_key_run_budget_usd: number
  api_key_monthly_budget_usd: number | null
}

/** When a limit resets; never for one that isn't running (no reset time). */
const resetTime = (limit: ClaudeUsageLimit) => (limit.resetsAt === null ? Infinity : Date.parse(limit.resetsAt))

/** Whether the limit `a` lifts after `b`: it resets later, or at the same time and is more used. */
const liftsAfter = (a: ClaudeUsageLimit, b: ClaudeUsageLimit) =>
  resetTime(a) > resetTime(b) || (resetTime(a) === resetTime(b) && a.percent > b.percent)

/**
 * The limit that holds agents back with the usage reserve at `at` (see `ClaudeUsage.reserveReached`): of the limits at
 * or over their reserve that haven't reset since the report, the one that lifts last, when the report is fresh. Unless
 * agents may spend usage credits or go on on their API key (`apiKey.usable`), a limit that is used up holds them back
 * without a reserve too. A stale or missing report never holds them back, so agents don't stop with a supervisor that
 * did.
 */
export function reserveReached(
  {
    reportedAt,
    limits,
    reserve,
    apiKey,
  }: Pick<ClaudeUsage, 'reportedAt' | 'limits' | 'reserve'> & {
    apiKey?: Pick<AgentApiKey, 'usable'>
  },
  at = Date.now(),
): ClaudeUsageLimit | null {
  if (!reportedAt || Date.parse(reportedAt) < at - CLAUDE_USAGE_FRESH_MINUTES * 60_000) return null
  const goOn = reserve.usageCredits || !!apiKey?.usable
  const reached = limits.filter((limit) => {
    const percent = reserveFor(limit, reserve) ?? (goOn ? null : 100)
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
    credits: JSON.parse(row.credits) as ClaudeUsageCredit[],
    error: row.error,
    reserve: {
      week: row.week_reserve_percent,
      session: row.session_reserve_percent,
      usageCredits: row.usage_credits === 1,
    },
    apiKey: toApiKey(row),
  }
  return { ...usage, reserveReached: reserveReached(usage) }
}

/** The start of the calendar month (UTC) `at` is in, as stored timestamps are written. */
export const monthStart = (at = new Date()) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString()

function toApiKey(row: ClaudeUsageRow): AgentApiKey {
  const available =
    sql.get<{ agents_api_key: number }>('SELECT agents_api_key FROM setup WHERE id = 1')?.agents_api_key === 1
  const spent =
    sql.get<{ cost: number | null }>(
      'SELECT sum(cost_usd) AS cost FROM token_usage WHERE api_key = 1 AND created_at >= ?',
      monthStart(),
    )?.cost ?? 0
  const enabled = row.api_key_fallback === 1
  const monthly = row.api_key_monthly_budget_usd
  return {
    enabled,
    available,
    runBudgetUsd: row.api_key_run_budget_usd,
    monthlyBudgetUsd: monthly,
    spentThisMonthUsd: spent,
    usable: enabled && available && (monthly === null || spent < monthly),
  }
}

export const getClaudeUsage = () => toClaudeUsage(sql.get<ClaudeUsageRow>('SELECT * FROM claude_usage WHERE id = 1')!)

/** Sets what agents do once Claude usage runs out (see `AgentApiKey`); what the input leaves out stays as it is. */
export function setAgentApiKey({ enabled, runBudgetUsd, monthlyBudgetUsd }: SetAgentApiKeyInput): ClaudeUsage {
  const current = getClaudeUsage().apiKey
  sql.run(
    `UPDATE claude_usage SET api_key_fallback = ?, api_key_run_budget_usd = ?, api_key_monthly_budget_usd = ?
     WHERE id = 1`,
    (enabled ?? current.enabled) ? 1 : 0,
    runBudgetUsd ?? current.runBudgetUsd,
    monthlyBudgetUsd === undefined ? current.monthlyBudgetUsd : monthlyBudgetUsd,
  )
  return getClaudeUsage()
}

/**
 * Sets the usage reserve of the week, the current session or both (see `ClaudeUsageReserve`), null switching it off,
 * and whether agents may spend usage credits.
 */
export function setUsageReserve({ week, session, usageCredits }: SetUsageReserveInput): ClaudeUsage {
  const current = getClaudeUsage().reserve
  sql.run(
    'UPDATE claude_usage SET week_reserve_percent = ?, session_reserve_percent = ?, usage_credits = ? WHERE id = 1',
    week === undefined ? current.week : week,
    session === undefined ? current.session : session,
    (usageCredits ?? current.usageCredits) ? 1 : 0,
  )
  return getClaudeUsage()
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A time the usage endpoint gave, or null for anything that isn't one. */
const timeOf = (value: unknown) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null)

function toLimit(label: string, percent: unknown, resetsAt: unknown): ClaudeUsageLimit[] {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return []
  return [
    {
      label,
      percent: Math.min(100, Math.max(0, percent)),
      resetsAt: timeOf(resetsAt),
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

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** An amount of money in the usage endpoint's `{ amount_minor, currency, exponent }`, e.g. 1250 cents for $12.50. */
function money(value: unknown): { amount: number; currency: string } | null {
  if (!isObject(value) || !isAmount(value.amount_minor)) return null
  const exponent = Number.isInteger(value.exponent) ? (value.exponent as number) : 2
  return {
    amount: value.amount_minor / 10 ** exponent,
    currency: typeof value.currency === 'string' ? value.currency : 'USD',
  }
}

/**
 * Usage credits (extra usage), on or off: from `spend`, or the older `extra_usage` (in cents, or `decimal_places`)
 * without it. Null when the answer has neither.
 */
function usageCredits(usage: Record<string, unknown>): ClaudeUsageCredit | null {
  const { spend, extra_usage: extra } = usage
  const credit = { kind: 'usage', label: 'Usage credits', resetsAt: null } as const
  if (isObject(spend)) {
    const used = money(spend.used)
    const limit = money(spend.limit)
    const balance = money(spend.balance)
    return {
      ...credit,
      enabled: spend.enabled === true,
      currency: used?.currency ?? limit?.currency ?? balance?.currency ?? 'USD',
      used: used?.amount ?? 0,
      limit: limit?.amount ?? null,
      remaining: balance?.amount ?? (limit ? Math.max(0, limit.amount - (used?.amount ?? 0)) : null),
    }
  }
  if (!isObject(extra)) return null
  const scale = 10 ** (Number.isInteger(extra.decimal_places) ? (extra.decimal_places as number) : 2)
  const used = isAmount(extra.used_credits) ? extra.used_credits / scale : 0
  const limit = isAmount(extra.monthly_limit) ? extra.monthly_limit / scale : null
  return {
    ...credit,
    enabled: extra.is_enabled === true,
    currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
  }
}

/**
 * The credits in an answer of the usage endpoint (see `parseClaudeUsage`): every grant of dollars (an entry with
 * `limit_dollars`, under a name that changes), then usage credits, whether they are on or not. Like the limits,
 * anything that doesn't look as expected is left out.
 */
export function parseClaudeCredits(usage: Record<string, unknown>): ClaudeUsageCredit[] {
  const grants = Object.values(usage)
    .filter(isObject)
    .flatMap((grant): ClaudeUsageCredit[] => {
      const { limit_dollars: limit, used_dollars: used, remaining_dollars: remaining } = grant
      if (!isAmount(limit)) return []
      const spent = isAmount(used) ? used : isAmount(remaining) ? Math.max(0, limit - remaining) : 0
      return [
        {
          kind: 'grant',
          label: 'Credit grant',
          enabled: true,
          currency: 'USD',
          used: spent,
          limit,
          remaining: isAmount(remaining) ? remaining : Math.max(0, limit - spent),
          resetsAt: timeOf(grant.resets_at),
        },
      ]
    })
  const credits = usageCredits(usage)
  return credits ? [...grants, credits] : grants
}

/** Records what the supervisor read; a report with neither usage nor an error only updates the plan and the time. */
export function reportClaudeUsage(input: ReportClaudeUsageInput): ClaudeUsage {
  const current = getClaudeUsage()
  const limits = input.usage ? parseClaudeUsage(input.usage) : input.error ? [] : current.limits
  const credits = input.usage ? parseClaudeCredits(input.usage) : input.error ? [] : current.credits
  sql.run(
    'UPDATE claude_usage SET reported_at = ?, plan = ?, limits = ?, credits = ?, error = ? WHERE id = 1',
    now(),
    input.plan === undefined ? current.plan : input.plan,
    JSON.stringify(limits),
    JSON.stringify(credits),
    input.usage ? null : (input.error ?? current.error),
  )
  return getClaudeUsage()
}
