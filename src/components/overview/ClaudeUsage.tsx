import type { ClaudeUsage as ClaudeUsageData, ClaudeUsageLimit } from '@shared/domain'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Reports older than this are likely from a supervisor that stopped; it reports every five minutes. */
const STALE_MS = 20 * 60 * 1000

function LimitBar({ limit, now }: { limit: ClaudeUsageLimit; now: number }) {
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
            <LimitBar key={limit.label} limit={limit} now={now} />
          ))}
        </div>
      )}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </div>
  )
}
