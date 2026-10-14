import { SquareIcon } from 'lucide-react'
import { type SyntheticEvent, useState } from 'react'
import { AGENT_IDLE_MINUTES, AGENT_RUN_STALLED_MINUTES, type Ticket } from '@shared/domain'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { formatDuration, ticketRef } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useBoardContext } from './board-context'

const stopPropagation = (event: SyntheticEvent) => event.stopPropagation()

/**
 * The agent run working a ticket: how long it has gone on and its step, or that its heartbeats stopped, with a button
 * that stops it; "Stopping…" once someone asked it to stop, until it has. Render it only for a ticket with a run, as it
 * keeps a timer.
 */
export function RunStatus({ ticket, className }: { ticket: Ticket; className?: string }) {
  const now = useNow(15_000)
  const { run } = ticket
  if (!run) return null
  const silentMs = now - Date.parse(run.seenAt)
  // The board isn't told when heartbeats stop, so the run ends here by the same rule as on the server.
  if (silentMs >= AGENT_IDLE_MINUTES * 60_000) return null
  const stalled = silentMs >= AGENT_RUN_STALLED_MINUTES * 60_000
  const stopping = run.stopRequested
  const elapsed = formatDuration(now - Date.parse(run.startedAt))
  const title = stopping
    ? `${stopping.by} asked the agent run to stop ${formatDuration(now - Date.parse(stopping.at))} ago. Its loop ` +
      'stops it at its next check of the ticket, and it carries on where it left off once there is new feedback.'
    : stalled
      ? `Agent run started ${elapsed} ago; no heartbeat for ${formatDuration(silentMs)}, it may have stalled`
      : `Agent run going on for ${elapsed}${run.step ? `: ${run.step}` : ''}`

  return (
    <div
      className={cn(
        'mt-2 flex min-w-0 items-center gap-1.5 text-[11px]',
        stalled || stopping ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400',
        className,
      )}
      title={title}
    >
      <span className="relative flex size-2 shrink-0">
        {!stalled && !stopping && <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-60" />}
        <span className="relative size-2 rounded-full bg-current" />
      </span>
      <span className="shrink-0 font-medium tabular-nums">
        {stopping ? 'Stopping…' : stalled ? `No heartbeat for ${formatDuration(silentMs)}` : `Running ${elapsed}`}
      </span>
      {!stalled && !stopping && run.step && <span className="truncate text-muted-foreground">· {run.step}</span>}
      {!stopping && <StopRunButton ticket={ticket} />}
    </div>
  )
}

/** Stops the agent run working a ticket after a confirmation; the agent keeps its work and resumes on new feedback. */
function StopRunButton({ ticket }: { ticket: Ticket }) {
  const { actions } = useBoardContext()
  const [confirming, setConfirming] = useState(false)

  return (
    // The dialog's events bubble through React to the card even though it is portaled: keep them, and the button's,
    // from opening the ticket or starting a drag.
    <div
      className="-my-1 ml-auto shrink-0 pl-1"
      onClick={stopPropagation}
      onPointerDown={stopPropagation}
      onKeyDown={stopPropagation}
    >
      <Button
        size="xs"
        variant="outline"
        className="h-5 px-1.5 text-[11px] text-foreground"
        title="Stop the agent's run, e.g. to give it new instructions"
        onClick={() => setConfirming(true)}
      >
        <SquareIcon />
        Stop
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Stop the agent's run on ${ticketRef(ticket.number)}?`}
        description="The agent stops within half a minute and keeps what it has done so far. It carries on where it left off once there is new feedback: comment on the ticket to tell it what to do instead."
        confirmLabel="Stop run"
        onConfirm={() => void actions.stopRun(ticket.id)}
      />
    </div>
  )
}
