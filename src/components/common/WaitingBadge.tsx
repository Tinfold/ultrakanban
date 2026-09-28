import { ClipboardCheckIcon, MessageCircleQuestionIcon } from 'lucide-react'
import type { Ticket } from '@shared/domain'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Shown while a ticket's agent waits for a person: approval of its plan, or an answer to its latest comment. */
export function WaitingBadge({ ticket, className }: { ticket: Ticket; className?: string }) {
  if (ticket.approval === 'pending') {
    return (
      <span
        className={cn('flex shrink-0 items-center gap-1 text-violet-600 dark:text-violet-400', className)}
        title={`${ticket.assignee ?? 'The agent'} estimated it at size ${ticket.estimate} and waits for someone to approve its plan before working it`}
      >
        <ClipboardCheckIcon />
        Awaiting approval
      </span>
    )
  }
  if (!ticket.waitingSince) return null
  return (
    <span
      className={cn('flex shrink-0 items-center gap-1 text-sky-600 dark:text-sky-400', className)}
      title={`${ticket.assignee} commented on ${formatDateTime(ticket.waitingSince)} and is waiting for an answer`}
    >
      <MessageCircleQuestionIcon />
      Waiting on you
    </span>
  )
}
