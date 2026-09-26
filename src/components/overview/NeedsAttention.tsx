import { Link } from 'wouter'
import type { OverviewTicket } from '@shared/domain'
import { PullRequestIcon } from '@/components/common/PullRequestIcon'
import { UserAvatar } from '@/components/common/UserAvatar'
import { formatDateTime, formatDuration, ticketRef } from '@/lib/format'
import { ticketHref } from '@/lib/overview'

type HeldTicket = OverviewTicket & { agent: string }

function Group({ title, tickets, now }: { title: string; tickets: HeldTicket[]; now: number }) {
  if (!tickets.length) return null
  return (
    <div className="grid grid-cols-1 gap-1">
      <h3 className="px-2 text-xs text-muted-foreground">{title}</h3>
      <ul className="grid grid-cols-1">
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <Link
              href={ticketHref(ticket)}
              className="flex gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            >
              <UserAvatar name={ticket.agent} size="xs" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-muted-foreground">{ticketRef(ticket.number)}</span>
                  <span className="truncate text-foreground">{ticket.title}</span>
                  {ticket.pullRequest && <PullRequestIcon state={ticket.pullRequest.state} className="size-3.5" />}
                </span>
                <span className="block truncate text-muted-foreground">
                  {ticket.agent} · {ticket.boardName}
                </span>
              </span>
              <time
                dateTime={ticket.since}
                title={`In ${ticket.column} since ${formatDateTime(ticket.since)}`}
                className="shrink-0 text-muted-foreground tabular-nums"
              >
                {formatDuration(now - Date.parse(ticket.since))}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface NeedsAttentionProps {
  review: HeldTicket[]
  stalled: HeldTicket[]
  now: number
}

export function NeedsAttention({ review, stalled, now }: NeedsAttentionProps) {
  if (!review.length && !stalled.length) {
    return <p className="px-1 text-sm text-muted-foreground">Nothing is waiting on you.</p>
  }

  return (
    <div className="grid grid-cols-1 gap-3 rounded-xl border bg-card p-2">
      <Group title="Waiting for review, oldest first" tickets={review} now={now} />
      <Group title="Worked for over a day without moving" tickets={stalled} now={now} />
    </div>
  )
}
