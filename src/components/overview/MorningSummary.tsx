import { format, parseISO } from 'date-fns'
import { useState } from 'react'
import { Link } from 'wouter'
import type { MorningSummaryBoard, MorningSummaryTicket } from '@shared/domain'
import { PullRequestAnchor } from '@/components/common/PullRequestAnchor'
import { PullRequestIcon } from '@/components/common/PullRequestIcon'
import { COST_NOTE, formatDateTime, formatUsage, ticketRef } from '@/lib/format'
import { hadActivity, ticketHref } from '@/lib/overview'
import { PULL_REQUEST_STATE_LABELS } from '@/lib/pull-request'

/** How many tickets a group lists before it folds the rest away, to keep the summary brief. */
const LISTED = 5

const count = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`

function TicketGroup({ title, tickets }: { title: string; tickets: MorningSummaryTicket[] }) {
  const [expanded, setExpanded] = useState(false)
  if (!tickets.length) return null
  const folded = tickets.length - LISTED
  return (
    <div className="grid grid-cols-1 gap-0.5">
      <h4 className="px-2 text-xs text-muted-foreground">
        {title} <span className="tabular-nums">({tickets.length})</span>
      </h4>
      <ul className="grid grid-cols-1">
        {(expanded ? tickets : tickets.slice(0, LISTED)).map((ticket) => (
          <li key={ticket.id} className="flex items-center gap-1 rounded-md hover:bg-muted">
            <Link
              href={ticketHref(ticket)}
              className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded-md px-2 py-1 text-xs focus-visible:bg-muted focus-visible:outline-none"
            >
              <span className="font-mono text-muted-foreground">{ticketRef(ticket.number)}</span>
              <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
              <time
                dateTime={ticket.at}
                title={formatDateTime(ticket.at)}
                className="shrink-0 text-muted-foreground tabular-nums"
              >
                {format(parseISO(ticket.at), 'HH:mm')}
              </time>
            </Link>
            {ticket.pullRequest && (
              <PullRequestAnchor
                href={ticket.pullRequest.url}
                aria-label={`Open the pull request (${PULL_REQUEST_STATE_LABELS[ticket.pullRequest.state].toLowerCase()})`}
                title="Open the pull request"
                className="shrink-0 rounded-md p-1.5 hover:bg-background focus-visible:bg-background focus-visible:outline-none"
              >
                <PullRequestIcon state={ticket.pullRequest.state} className="size-3.5" />
              </PullRequestAnchor>
            )}
          </li>
        ))}
      </ul>
      {folded > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="justify-self-start rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
        >
          {expanded ? 'Show fewer' : `Show ${folded} more`}
        </button>
      )}
    </div>
  )
}

function BoardSummary({ board }: { board: MorningSummaryBoard }) {
  const { completed, review, waiting, created, comments, usage } = board
  const listed = completed.length + review.length + waiting.length
  const activity = [
    created > 0 && count(created, 'new ticket'),
    comments > 0 && count(comments, 'comment'),
    // Moves, claims and the like only say something on a board with nothing else to tell.
    !created && !comments && !listed && board.events > 0 && count(board.events, 'update'),
    usage.tokens > 0 && formatUsage(usage),
  ].filter(Boolean)
  return (
    <section className="grid grid-cols-1 content-start gap-2 rounded-xl border bg-card p-2">
      <h3 className="truncate px-2 pt-1 text-sm font-medium">
        <Link href={`/b/${board.id}`} className="hover:underline">
          {board.name}
        </Link>
      </h3>
      <TicketGroup title="Waiting for an answer or approval" tickets={waiting} />
      <TicketGroup title="Ready for review" tickets={review} />
      <TicketGroup title="Completed" tickets={completed} />
      {activity.length > 0 && (
        <p className="px-2 pb-1 text-xs text-muted-foreground" title={usage.costUsd !== null ? COST_NOTE : undefined}>
          {activity.join(', ')}
        </p>
      )}
    </section>
  )
}

export function MorningSummary({ boards }: { boards: MorningSummaryBoard[] }) {
  const active = boards.filter(hadActivity)
  const quiet = boards.filter((board) => !hadActivity(board))
  if (!active.length)
    return <p className="px-1 text-sm text-muted-foreground">All quiet: nothing happened overnight.</p>
  return (
    <>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {active.map((board) => (
          <BoardSummary key={board.id} board={board} />
        ))}
      </div>
      {quiet.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          Nothing happened on {quiet.map((board) => board.name).join(', ')}.
        </p>
      )}
    </>
  )
}
