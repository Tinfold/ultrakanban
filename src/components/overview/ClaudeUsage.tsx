import { useQueryClient } from '@tanstack/react-query'
import { CirclePauseIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  CLAUDE_USAGE_FRESH_MINUTES,
  type ClaudeUsage as ClaudeUsageData,
  type ClaudeUsageLimit,
  isWeeklyLimit,
} from '@shared/domain'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { queryKeys } from '@/hooks/queries'
import { api, errorMessage } from '@/lib/api'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Reports older than this are likely from a supervisor that stopped; it reports every five minutes. */
const STALE_MS = 20 * 60 * 1000

/** The usage reserves offered; one set to another percent through the API is offered too. */
const RESERVE_CHOICES = [50, 60, 70, 75, 80, 85, 90, 95]
const RESERVE_OFF = 'off'

/** A weekly limit's name in a sentence: `week` for all models, `Opus week` for one. */
function weekName(label: string) {
  const model = /^Week, (.+)$/.exec(label)?.[1]
  return model === undefined ? label : model === 'all models' ? 'week' : `${model} week`
}

function LimitBar({ limit, now, reserve }: { limit: ClaudeUsageLimit; now: number; reserve: number | null }) {
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : null
  // Past its reset time the limit starts again from nothing, even before the next report says so.
  const reset = resetsAt !== null && resetsAt <= now
  const percent = reset ? 0 : Math.round(limit.percent)
  // The reserve counts the week's limits, not the current session's.
  const reserveMark = reserve !== null && isWeeklyLimit(limit) ? reserve : null
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
        {reserveMark !== null && (
          <div
            className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
            style={{ left: `${reserveMark}%` }}
            title={`Usage reserve: agents claim no new tickets from ${reserveMark}% used`}
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

/**
 * The usage reserve: the share of the week after which agents claim no new tickets, keeping the rest for the user's own
 * sessions, and whether it holds them back now.
 */
function UsageReserve({ usage, now }: { usage: ClaudeUsageData; now: number }) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const { reservePercent, reserveReached, reportedAt } = usage
  const choices = [...new Set([...RESERVE_CHOICES, ...(reservePercent === null ? [] : [reservePercent])])].sort(
    (a, b) => a - b,
  )
  // Without any report the card says so already.
  const stale = reportedAt !== null && now - Date.parse(reportedAt) > CLAUDE_USAGE_FRESH_MINUTES * 60_000

  const change = async (value: string) => {
    setSaving(true)
    try {
      const reserve = value === RESERVE_OFF ? null : Number(value)
      queryClient.setQueryData(queryKeys.claudeUsage, await api.setUsageReserve(reserve))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <label htmlFor="usage-reserve" className="font-medium text-foreground">
          Usage reserve
        </label>
        <Select value={reservePercent === null ? RESERVE_OFF : String(reservePercent)} onValueChange={change}>
          <SelectTrigger id="usage-reserve" size="sm" className="h-7 text-xs" disabled={saving}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={RESERVE_OFF}>Off</SelectItem>
            {choices.map((percent) => (
              <SelectItem key={percent} value={String(percent)}>
                From {percent}% of the week
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>
          {reservePercent === null
            ? 'Agents may use the whole week.'
            : `Agents claim no new tickets once a weekly limit is ${reservePercent}% used, keeping the rest for you. Tickets they hold still get runs for their feedback.`}
        </span>
      </div>
      {reserveReached && (
        <p className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
          <CirclePauseIcon className="size-4 shrink-0" />
          Agents paused new tickets: {weekName(reserveReached.label)} at {Math.round(reserveReached.percent)}%, reserve
          starts at {reservePercent}%.
        </p>
      )}
      {reservePercent !== null && !reserveReached && stale && (
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
  const { reportedAt, plan, limits, error } = usage
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
      {limits.length > 0 && (
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {limits.map((limit) => (
            <LimitBar key={limit.label} limit={limit} now={now} reserve={usage.reservePercent} />
          ))}
        </div>
      )}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <UsageReserve usage={usage} now={now} />
    </div>
  )
}
