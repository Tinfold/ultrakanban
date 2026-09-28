import { AGENT_IDLE_MINUTES, AGENT_RUN_STALLED_MINUTES, type AgentRun } from '@shared/domain'
import { useNow } from '@/hooks/use-now'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The agent run working a ticket: how long it has gone on and its step, or that its heartbeats stopped. */
export function RunStatus({ run }: { run: AgentRun }) {
  const now = useNow(15_000)
  const silentMs = now - Date.parse(run.seenAt)
  // The board isn't told when heartbeats stop, so the run ends here by the same rule as on the server.
  if (silentMs >= AGENT_IDLE_MINUTES * 60_000) return null
  const stalled = silentMs >= AGENT_RUN_STALLED_MINUTES * 60_000
  const elapsed = formatDuration(now - Date.parse(run.startedAt))
  const title = stalled
    ? `Agent run started ${elapsed} ago; no heartbeat for ${formatDuration(silentMs)}, it may have stalled`
    : `Agent run going on for ${elapsed}${run.step ? `: ${run.step}` : ''}`

  return (
    <div
      className={cn(
        'mt-2 flex min-w-0 items-center gap-1.5 text-[11px]',
        stalled ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400',
      )}
      title={title}
    >
      <span className="relative flex size-2 shrink-0">
        {!stalled && <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-60" />}
        <span className="relative size-2 rounded-full bg-current" />
      </span>
      <span className="shrink-0 font-medium tabular-nums">
        {stalled ? `No heartbeat for ${formatDuration(silentMs)}` : `Running ${elapsed}`}
      </span>
      {!stalled && run.step && <span className="truncate text-muted-foreground">· {run.step}</span>}
    </div>
  )
}
