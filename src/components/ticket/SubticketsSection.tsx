import { Link } from 'wouter'
import type { Ticket } from '@shared/domain'
import { PriorityIcon } from '@/components/common/PriorityIcon'
import { ColorDot } from '@/components/common/TagChip'
import { UserAvatar } from '@/components/common/UserAvatar'
import { ticketRef } from '@/lib/format'
import { ticketHref } from '@/lib/overview'
import { cn } from '@/lib/utils'
import { useBoardContext } from '../board/board-context'

/** The tickets a ticket was split into, with how many of them are finished. */
export function SubticketsSection({ ticket }: { ticket: Ticket }) {
  const { detail, columnsById } = useBoardContext()
  const subtickets = detail.tickets.filter((other) => other.parentId === ticket.id)
  if (!subtickets.length && !ticket.subtickets) return null
  const doneColumnId = detail.board.doneColumnId ?? detail.columns.at(-1)?.id
  const progress = ticket.subtickets

  return (
    <section aria-labelledby="subtickets-heading" className="grid gap-3">
      <div className="flex items-center gap-2">
        <h3 id="subtickets-heading" className="text-sm font-medium">
          Sub-tickets
        </h3>
        {progress && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {progress.done}/{progress.total} done
          </span>
        )}
      </div>
      {progress && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-labelledby="subtickets-heading"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width]"
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      )}
      <ul className="-mx-2 grid gap-0.5">
        {subtickets.map((subticket) => {
          const column = columnsById.get(subticket.columnId)
          const done = subticket.columnId === doneColumnId || subticket.pullRequest?.state === 'merged'
          return (
            <li key={subticket.id}>
              <Link
                href={ticketHref(subticket)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
              >
                <PriorityIcon priority={subticket.priority} className="size-3.5 shrink-0" />
                <span className="font-mono text-xs text-muted-foreground">{ticketRef(subticket.number)}</span>
                <span className={cn('min-w-0 flex-1 truncate', done && 'text-muted-foreground line-through')}>
                  {subticket.title}
                </span>
                {subticket.assignee && <UserAvatar name={subticket.assignee} size="xs" />}
                {column && (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <ColorDot color={column.color} />
                    {column.name}
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
