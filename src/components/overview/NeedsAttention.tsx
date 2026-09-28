import { Link } from 'wouter'
import type { OverviewTicket } from '@shared/domain'
import { PullRequestIcon } from '@/components/common/PullRequestIcon'
import { UserAvatar } from '@/components/common/UserAvatar'
import { formatDateTime, formatDuration, ticketRef } from '@/lib/format'
import { ticketHref } from '@/lib/overview'
import { PULL_REQUEST_STATE_LABELS } from '@/lib/pull-request'

type HeldTicket = OverviewTicket & { agent: string }

interface GroupProps {
  title: string
  tickets: HeldTicket[]
  now: number
  /** Time them from when their agent started waiting for an answer, rather than from when they entered their column. */
  waiting?: boolean
}

function Group({ title, tickets, now, waiting }: GroupProps) {
  if (!tickets.length) return null
  const timedFrom = (ticket: HeldTicket) => (waiting && ticket.waitingSince) || ticket.since
  return (
    <div className="grid grid-cols-1 gap-1">
      <h3 className="px-2 text-xs text-muted-foreground">{title}</h3>
      <ul className="grid grid-cols-1">
        {tickets.map((ticket) => (
          <li key={ticket.id} className="flex items-start gap-1 rounded-md hover:bg-muted">
            <Link
              href={ticketHref(ticket)}
              className="flex min-w-0 flex-1 gap-2 rounded-md px-2 py-1.5 text-xs focus-visible:bg-muted focus-visible:outline-none"
            >
              <UserAvatar name={ticket.agent} size="xs" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-muted-foreground">{ticketRef(ticket.number)}</span>
                  <span className="truncate text-foreground">{ticket.title}</span>
                </span>
                <span className="block truncate text-muted-foreground">
                  {ticket.agent} · {ticket.boardName}
                </span>
              </span>
              <time
                dateTime={timedFrom(ticket)}
                title={
                  waiting
                    ? `Waiting for ${ticket.approval === 'pending' ? 'approval of its plan' : 'an answer'} since ${formatDateTime(timedFrom(ticket))}`
                    : `In ${ticket.column} since ${formatDateTime(ticket.since)}`
                }
                className="shrink-0 text-muted-foreground tabular-nums"
              >
                {formatDuration(now - Date.parse(timedFrom(ticket)))}
              </time>
            </Link>
            {ticket.pullRequest && (
              // Straight to the pull request, for reviewing without opening the ticket first.
              <a
                href={ticket.pullRequest.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open the pull request (${PULL_REQUEST_STATE_LABELS[ticket.pullRequest.state].toLowerCase()})`}
                title="Open the pull request"
                className="shrink-0 rounded-md p-2 hover:bg-background focus-visible:bg-background focus-visible:outline-none"
              >
                <PullRequestIcon state={ticket.pullRequest.state} className="size-3.5" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

interface NeedsAttentionProps {
  waiting: HeldTicket[]
  review: HeldTicket[]
  stalled: HeldTicket[]
  now: number
}

export function NeedsAttention({ waiting, review, stalled, now }: NeedsAttentionProps) {
  if (!waiting.length && !review.length && !stalled.length) {
    return <p className="px-1 text-sm text-muted-foreground">Nothing is waiting on you.</p>
  }

  return (
    <div className="grid grid-cols-1 gap-3 rounded-xl border bg-card p-2">
      <Group title="Agent waiting for an answer or approval, oldest first" tickets={waiting} now={now} waiting />
      <Group title="Waiting for review, oldest first" tickets={review} now={now} />
      <Group title="Worked for over a day without moving" tickets={stalled} now={now} />
    </div>
  )
}
