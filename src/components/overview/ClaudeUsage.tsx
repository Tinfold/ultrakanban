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
import type { SetUsageReserveInput } from '@shared/schemas'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { queryKeys } from '@/hooks/queries'
import { api, errorMessage } from '@/lib/api'
import { formatDateTime, formatDuration, formatMoney, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Reports older than this are likely from a supervisor that stopped; it reports every five minutes. */
const STALE_MS = 20 * 60 * 1000

/** The usage reserves offered, for the week and the session alike; one set to another percent through the API too. */
const RESERVE_CHOICES = [50, 60, 70, 75, 80, 85, 90, 95]
const RESERVE_OFF = 'off'

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

/** Money the account can spend on usage besides its limits: how much is left, and a bar of what's used when it has a limit. */
function CreditBar({ credit, now }: { credit: ClaudeUsageCredit; now: number }) {
  const { label, currency, used, limit, remaining, resetsAt } = credit
  const money = (amount: number) => formatMoney(amount, currency)
  const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : null
  const resetsIn = resetsAt === null ? null : Date.parse(resetsAt) - now
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        {remaining !== null && (
          <span className="text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">{money(remaining)}</span> left
          </span>
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
          {money(used)} used{limit !== null && ` of ${money(limit)}`}
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
  const { reserve, reserveReached, reportedAt } = usage
  const set = reserve.week !== null || reserve.session !== null
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
      </div>
      <p className="text-xs text-muted-foreground">
        {set
          ? `Agents claim no new tickets once ${bounds.join(' or ')}, keeping the rest for you. Tickets they hold still get runs for their feedback.`
          : 'Agents may use the whole week and every session.'}
      </p>
      {reserveReached && (
        <p className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
          <CirclePauseIcon className="size-4 shrink-0" />
          Agents paused new tickets: {limitName(reserveReached)} at {Math.round(reserveReached.percent)}%, reserve
          starts at {reserveFor(reserveReached, reserve)}%.
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
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <UsageReserve usage={usage} now={now} />
    </div>
  )
}
