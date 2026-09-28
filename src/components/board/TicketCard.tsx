import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CalendarIcon, GitMergeConflictIcon, MessageSquareIcon, PaperclipIcon, SquareCheckIcon } from 'lucide-react'
import type { Ticket } from '@shared/domain'
import { PriorityIcon } from '@/components/common/PriorityIcon'
import { PullRequestIcon } from '@/components/common/PullRequestIcon'
import { TagChip } from '@/components/common/TagChip'
import { UserAvatar } from '@/components/common/UserAvatar'
import { dueState, formatDueDate, ticketRef } from '@/lib/format'
import { checklistProgress } from '@/lib/markdown'
import { CONFLICTS_HINT } from '@/lib/pull-request'
import { cn } from '@/lib/utils'
import { useBoardContext } from './board-context'
import { QuickMergeButton } from './QuickMergeButton'
import { RunStatus } from './RunStatus'

const DUE_STYLES = {
  overdue: 'text-red-600 dark:text-red-400',
  soon: 'text-amber-600 dark:text-amber-400',
  later: '',
}

interface TicketCardProps {
  ticket: Ticket
  overlay?: boolean
}

export function TicketCard({ ticket, overlay }: TicketCardProps) {
  const { detail, tagsById } = useBoardContext()
  const checklist = checklistProgress(ticket.description)
  const tags = ticket.tagIds.flatMap((tagId) => tagsById.get(tagId) ?? [])
  const hasMeta =
    ticket.dueDate || checklist.total > 0 || ticket.commentCount > 0 || ticket.attachmentCount > 0 || ticket.pullRequest
  const canMerge =
    !overlay &&
    ticket.columnId === detail.board.reviewColumnId &&
    (ticket.pullRequest?.state === 'open' || ticket.pullRequest?.state === 'unknown')

  return (
    <div
      className={cn(
        'rounded-lg border bg-card px-3 py-2.5 text-card-foreground shadow-xs transition-[border-color,box-shadow] hover:border-foreground/15',
        overlay && 'rotate-[1.5deg] cursor-grabbing border-foreground/20 shadow-xl',
      )}
    >
      <div className="flex items-center gap-1.5">
        <PriorityIcon priority={ticket.priority} className="size-3.5" />
        <span className="font-mono text-[11px] text-muted-foreground">{ticketRef(ticket.number)}</span>
        {ticket.assignee && <UserAvatar name={ticket.assignee} size="xs" className="ml-auto" />}
      </div>
      <p className="mt-1.5 line-clamp-3 text-[13px] leading-snug font-medium text-pretty break-words">{ticket.title}</p>
      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
        </div>
      )}
      {hasMeta && (
        <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground [&_svg]:size-3">
          {ticket.dueDate && (
            <span className={cn('flex items-center gap-1', DUE_STYLES[dueState(ticket.dueDate)])}>
              <CalendarIcon />
              {formatDueDate(ticket.dueDate)}
            </span>
          )}
          {checklist.total > 0 && (
            <span
              className={cn(
                'flex items-center gap-1 tabular-nums',
                checklist.done === checklist.total && 'text-emerald-600 dark:text-emerald-400',
              )}
            >
              <SquareCheckIcon />
              {checklist.done}/{checklist.total}
            </span>
          )}
          {ticket.pullRequest && (
            <span className="flex items-center gap-1 tabular-nums" title={ticket.pullRequest.title ?? undefined}>
              <PullRequestIcon state={ticket.pullRequest.state} />#{ticket.pullRequest.number}
            </span>
          )}
          {ticket.pullRequest?.conflicts && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400" title={CONFLICTS_HINT}>
              <GitMergeConflictIcon />
              Conflicts
            </span>
          )}
          {ticket.attachmentCount > 0 && (
            <span className="flex items-center gap-1 tabular-nums">
              <PaperclipIcon />
              {ticket.attachmentCount}
            </span>
          )}
          {ticket.commentCount > 0 && (
            <span className="flex items-center gap-1 tabular-nums">
              <MessageSquareIcon />
              {ticket.commentCount}
            </span>
          )}
          {canMerge && <QuickMergeButton ticket={ticket} />}
        </div>
      )}
      {ticket.run && <RunStatus run={ticket.run} />}
    </div>
  )
}

interface SortableTicketCardProps {
  ticket: Ticket
  onOpen: (ticketId: string) => void
}

export function SortableTicketCard({ ticket, onOpen }: SortableTicketCardProps) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    data: { type: 'ticket' },
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        // A long press picks the ticket up on phones, so it must not select text or open the callout menu.
        'cursor-pointer rounded-lg outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [-webkit-touch-callout:none]',
        isDragging && 'opacity-40',
      )}
      aria-label={`${ticketRef(ticket.number)} ${ticket.title}`}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(ticket.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(ticket.id)
        else listeners?.onKeyDown?.(event)
      }}
    >
      <TicketCard ticket={ticket} />
    </div>
  )
}
