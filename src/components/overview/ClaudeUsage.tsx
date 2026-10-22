import { useQueryClient } from '@tanstack/react-query'
import { CirclePauseIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  CLAUDE_USAGE_FRESH_MINUTES,
  type ClaudeUsage as ClaudeUsageData,
  type ClaudeUsageCredit,
  type ClaudeUsageLimit,
  isSessionLimit,
  reserveFor,
} from '@shared/domain'
import type { SetAgentApiKeyInput, SetUsageReserveInput } from '@shared/schemas'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { queryKeys } from '@/hooks/queries'
import { api, errorMessage } from '@/lib/api'
import { formatCost, formatDateTime, formatDuration, formatMoney, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Why the credits leave API credits out. */
const API_CREDITS_NOTE =
  'Not API credits: those are a Claude Console balance that API keys spend, which your claude login can’t read.'

/** Reports older than this are likely from a supervisor that stopped; it reports every five minutes. */
const STALE_MS = 20 * 60 * 1000

/** The usage reserves offered, for the week and the session alike; one set to another percent through the API too. */
const RESERVE_CHOICES = [50, 60, 70, 75, 80, 85, 90, 95]
const RESERVE_OFF = 'off'
const CREDITS_SPEND = 'spend'
const CREDITS_KEEP = 'keep'
const RUN_OUT_WAIT = 'wait'
const RUN_OUT_API_KEY = 'api-key'

/** A limit's name in a sentence: `week` for all models, `Opus week` for one, `current session`. */
function limitName(limit: ClaudeUsageLimit) {
  if (isSessionLimit(limit)) return limit.label.toLowerCase()
  const model = /^Week, (.+)$/.exec(limit.label)?.[1]
  return model === undefined ? limit.label : model === 'all models' ? 'week' : `${model} week`
}

/** `reserve`: the usage reserve of the limit (see `reserveFor`), marked on the bar; null when off. */
function LimitBar({ limit, now, reserve }: { limit: ClaudeUsageLimit; now: number; reserve: number | null }) {
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : null
  // Past its reset time the limit starts again from nothing, even before the next report says so.
  const reset = resetsAt !== null && resetsAt <= now
  const percent = reset ? 0 : Math.round(limit.percent)
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{limit.label}</span>
        <span className="text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{100 - percent}%</span> left
        </span>
      </div>
      <div className="relative">
        <div
          role="meter"
          aria-label={`${limit.label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width]',
              percent >= 90 ? 'bg-destructive' : percent >= 70 ? 'bg-amber-500' : 'bg-primary',
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        {reserve !== null && (
          <div
            className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
            style={{ left: `${reserve}%` }}
            title={`Usage reserve: agents claim no new tickets from ${reserve}% used`}
          />
        )}
      </div>
      <div className="flex justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span>{percent}% used</span>
        {resetsAt !== null && (
          <span title={formatDateTime(limit.resetsAt!)}>
            {reset ? 'Reset' : `Resets in ${formatDuration(resetsAt - now)}`}
          </span>
        )}
      </div>
    </div>
  )
}

/** What each kind of credit is, as its tooltip says. */
const CREDIT_NOTES: Record<ClaudeUsageCredit['kind'], string> = {
  grant: 'Dollars granted to your Claude plan, spent on its usage.',
  usage:
    'Usage credits (extra usage on claude.ai) cover usage once a plan limit is reached, while they are switched on.',
}

/** Money the account can spend on usage besides its limits: how much is left, and a bar of what's used when it has a limit. */
function CreditBar({ credit, now }: { credit: ClaudeUsageCredit; now: number }) {
  const { kind, label, enabled, currency, used, limit, remaining, resetsAt } = credit
  const money = (amount: number) => formatMoney(amount, currency)
  const percent = enabled && limit ? Math.min(100, Math.round((used / limit) * 100)) : null
  const resetsIn = resetsAt === null ? null : Date.parse(resetsAt) - now
  return (
    <div className="grid gap-1.5" title={`${CREDIT_NOTES[kind]} ${API_CREDITS_NOTE}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        {!enabled ? (
          <span className="text-muted-foreground">Off</span>
        ) : (
          remaining !== null && (
            <span className="text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">{money(remaining)}</span> left
            </span>
          )
        )}
      </div>
      {percent !== null && (
        <div
          role="meter"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width]',
              percent >= 90 ? 'bg-destructive' : percent >= 70 ? 'bg-amber-500' : 'bg-primary',
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <div className="flex justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span>
          {enabled || used > 0
            ? `${money(used)} used${limit !== null ? ` of ${money(limit)}` : ''}`
            : 'Switched off on claude.ai'}
        </span>
        {resetsIn !== null && (
          <span title={formatDateTime(resetsAt!)}>
            {resetsIn <= 0 ? 'Reset' : `Resets in ${formatDuration(resetsIn)}`}
          </span>
        )}
      </div>
    </div>
  )
}

/** How far agents may use the week or the current session: off, or a percent of its limit. */
function ReserveSelect({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: number | null
  disabled: boolean
  onChange: (value: number | null) => void
}) {
  const choices = [...new Set([...RESERVE_CHOICES, ...(value === null ? [] : [value])])].sort((a, b) => a - b)
  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor={id}>{label}</label>
      <Select
        value={value === null ? RESERVE_OFF : String(value)}
        onValueChange={(next) => onChange(next === RESERVE_OFF ? null : Number(next))}
      >
        <SelectTrigger id={id} size="sm" className="h-7 text-xs" disabled={disabled}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={RESERVE_OFF}>Off</SelectItem>
          {choices.map((percent) => (
            <SelectItem key={percent} value={String(percent)}>
              From {percent}% used
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  )
}

/**
 * The usage reserve: how far agents may use the week and the current session before they claim no new tickets,
 * keeping the rest for the user's own work, and whether it holds them back now.
 */
function UsageReserve({ usage, now }: { usage: ClaudeUsageData; now: number }) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const { reserve, reserveReached, reportedAt, credits } = usage
  const set = reserve.week !== null || reserve.session !== null
  const creditsOn = credits.some((credit) => credit.kind === 'usage' && credit.enabled)
  const reachedPercent = reserveReached && reserveFor(reserveReached, reserve)
  const bounds = [
    ...(reserve.week === null ? [] : [`a weekly limit is ${reserve.week}% used`]),
    ...(reserve.session === null ? [] : [`the current session is ${reserve.session}% used`]),
  ]
  // Without any report the card says so already.
  const stale = reportedAt !== null && now - Date.parse(reportedAt) > CLAUDE_USAGE_FRESH_MINUTES * 60_000

  const change = async (input: SetUsageReserveInput) => {
    setSaving(true)
    try {
      queryClient.setQueryData(queryKeys.claudeUsage, await api.setUsageReserve(input))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Usage reserve</span>
        <ReserveSelect
          id="usage-reserve-week"
          label="Week"
          value={reserve.week}
          disabled={saving}
          onChange={(week) => change({ week })}
        />
        <ReserveSelect
          id="usage-reserve-session"
          label="Current session"
          value={reserve.session}
          disabled={saving}
          onChange={(session) => change({ session })}
        />
        <span className="flex items-center gap-1.5">
          <label htmlFor="usage-reserve-credits">Usage credits</label>
          <Select
            value={reserve.usageCredits ? CREDITS_SPEND : CREDITS_KEEP}
            onValueChange={(next) => change({ usageCredits: next === CREDITS_SPEND })}
          >
            <SelectTrigger id="usage-reserve-credits" size="sm" className="h-7 text-xs" disabled={saving}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CREDITS_KEEP}>Keep for me</SelectItem>
              <SelectItem value={CREDITS_SPEND}>Agents may spend them</SelectItem>
            </SelectContent>
          </Select>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {set
          ? `Agents claim no new tickets once ${bounds.join(' or ')}, keeping the rest for you. `
          : 'Agents may use the whole week and every session. '}
        {reserve.usageCredits
          ? `Once a limit is used up they go on claiming, ${creditsOn ? 'on your usage credits' : 'on usage credits if you switch them on'}. `
          : usage.apiKey.usable
            ? 'Once a limit is used up they go on claiming, and run on the API key (below). '
            : 'Once a limit is used up they claim none, rather than spend usage credits. '}
        Tickets they hold still get runs for their feedback.
      </p>
      {reserveReached && (
        <p className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
          <CirclePauseIcon className="size-4 shrink-0" />
          Agents paused new tickets: {limitName(reserveReached)}{' '}
          {reachedPercent === null
            ? `used up${creditsOn ? ', and they keep your usage credits for you' : ''}.`
            : `at ${Math.round(reserveReached.percent)}%, reserve starts at ${reachedPercent}%.`}
        </p>
      )}
      {set && !reserveReached && stale && (
        <p className="text-xs text-muted-foreground">
          The reserve only goes by a report from the last {CLAUDE_USAGE_FRESH_MINUTES} minutes, so it doesn’t hold
          agents back until the supervisor reports again.
        </p>
      )}
    </div>
  )
}

/**
 * A dollar amount the user types, saved when the field loses focus or on Enter: a positive number, or empty for none
 * when `optional`. Anything else goes back to the saved value.
 */
function DollarInput({
  id,
  label,
  value,
  optional,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: number | null
  optional?: boolean
  disabled: boolean
  onChange: (value: number | null) => void
}) {
  const saved = value === null ? '' : String(value)
  const [text, setText] = useState(saved)
  const [editing, setEditing] = useState(false)
  const commit = () => {
    setEditing(false)
    const trimmed = text.trim()
    const next = trimmed === '' ? null : Number(trimmed)
    if ((next === null && !optional) || (next !== null && !(next > 0))) return setText(saved)
    if (next !== value) onChange(next)
  }
  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor={id}>{label}</label>
      <span className="relative">
        <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2">$</span>
        <Input
          id={id}
          type="number"
          min="0.01"
          step="0.01"
          inputMode="decimal"
          placeholder={optional ? 'None' : undefined}
          className="h-7 w-20 pl-5 text-xs md:text-xs"
          disabled={disabled}
          value={editing ? text : saved}
          onFocus={() => {
            setText(saved)
            setEditing(true)
          }}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      </span>
    </span>
  )
}

/**
 * What agents do once Claude usage runs out (see `AgentApiKey`): wait for it to reset, or go on on their API key, within
 * a cap per run and per month, and what runs on the key spent this month.
 */
function ApiKeySetting({ usage }: { usage: ClaudeUsageData }) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const { enabled, available, runBudgetUsd, monthlyBudgetUsd, spentThisMonthUsd } = usage.apiKey
  const capReached = monthlyBudgetUsd !== null && spentThisMonthUsd >= monthlyBudgetUsd

  const change = async (input: SetAgentApiKeyInput) => {
    setSaving(true)
    try {
      queryClient.setQueryData(queryKeys.claudeUsage, await api.setAgentApiKey(input))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  let note: string
  if (!enabled) {
    note = 'Agents wait for the limit to reset. Tickets they hold get their runs then.'
  } else if (!available) {
    note =
      'The agents have no API key, so they wait for the limit to reset: set AGENT_API_KEY in their environment (see docs/agents.md).'
  } else {
    note =
      `A run that hits the limit is retried on the API key, and runs go on it until the limit resets, each spending at ` +
      `most ${formatCost(runBudgetUsd)}. Agents go on claiming new tickets, within the usage reserve. The key’s API ` +
      `credits are billed, unlike the plan’s estimated cost.`
  }

  return (
    <div className="grid gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <label htmlFor="usage-runs-out" className="font-medium text-foreground">
            When usage runs out
          </label>
          <Select
            value={enabled ? RUN_OUT_API_KEY : RUN_OUT_WAIT}
            onValueChange={(next) => change({ enabled: next === RUN_OUT_API_KEY })}
          >
            <SelectTrigger id="usage-runs-out" size="sm" className="h-7 text-xs" disabled={saving}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={RUN_OUT_WAIT}>Wait for it</SelectItem>
              <SelectItem value={RUN_OUT_API_KEY}>Use the API key</SelectItem>
            </SelectContent>
          </Select>
        </span>
        {enabled && (
          <>
            <DollarInput
              id="api-key-run-budget"
              label="Cap per run"
              value={runBudgetUsd}
              disabled={saving}
              onChange={(value) => value !== null && change({ runBudgetUsd: value })}
            />
            <DollarInput
              id="api-key-monthly-budget"
              label="Cap per month"
              value={monthlyBudgetUsd}
              optional
              disabled={saving}
              onChange={(value) => change({ monthlyBudgetUsd: value })}
            />
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
      {(enabled || spentThisMonthUsd > 0) && (
        <p className={cn('text-xs', capReached ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
          Billed to the API key this month: {formatCost(spentThisMonthUsd)}
          {monthlyBudgetUsd !== null && ` of ${formatCost(monthlyBudgetUsd)}`}
          {capReached && enabled && '. The monthly cap is reached, so agents wait for usage again.'}
        </p>
      )}
    </div>
  )
}

/** How much of the Claude plan's usage limits is used and left, as the agent supervisor last read it. */
export function ClaudeUsage({ usage, now }: { usage: ClaudeUsageData; now: number }) {
  const { reportedAt, plan, limits, credits, error } = usage
  let note: string | null = null
  if (!reportedAt) {
    note =
      'Not reported yet. The agent supervisor reads it on the host with your claude login (scripts/install-services.sh).'
  } else if (error) {
    note = error
  } else if (!limits.length) {
    note = 'Claude reported no usage limits.'
  }
  const stale = reportedAt !== null && now - Date.parse(reportedAt) > STALE_MS

  return (
    <div className="grid gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs text-muted-foreground">
          Claude usage
          {plan && (
            <>
              , <span className="capitalize">{plan}</span> plan
            </>
          )}
        </p>
        {reportedAt && (
          <p
            className={cn('text-xs', stale ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}
            title={formatDateTime(reportedAt)}
          >
            {stale ? 'Last reported' : 'Updated'} {formatRelative(reportedAt)}
          </p>
        )}
      </div>
      {limits.length + credits.length > 0 && (
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {limits.map((limit) => (
            <LimitBar key={limit.label} limit={limit} now={now} reserve={reserveFor(limit, usage.reserve)} />
          ))}
          {credits.map((credit, index) => (
            <CreditBar key={`${credit.label}-${index}`} credit={credit} now={now} />
          ))}
        </div>
      )}
      {credits.length > 0 && (
        <p className="text-xs text-muted-foreground">Credits here are your Claude plan’s. {API_CREDITS_NOTE}</p>
      )}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <UsageReserve usage={usage} now={now} />
      <ApiKeySetting usage={usage} />
    </div>
  )
}
