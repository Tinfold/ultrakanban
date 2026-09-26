import { BotIcon, XIcon } from 'lucide-react'
import { Link } from 'wouter'
import type { Color, OverviewAgent, OverviewBoard, OverviewTicket } from '@shared/domain'
import { PullRequestIcon } from '@/components/common/PullRequestIcon'
import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import { swatch } from '@/lib/colors'
import { formatDateTime, formatDuration, formatRelative, ticketRef } from '@/lib/format'
import { ticketHref } from '@/lib/overview'

const STATUSES: Record<OverviewAgent['status'], { label: string; color: Color }> = {
  working: { label: 'Working', color: 'green' },
  review: { label: 'Waiting for review', color: 'amber' },
  idle: { label: 'Idle', color: 'gray' },
}

function StatusBadge({ status }: { status: OverviewAgent['status'] }) {
  const { label, color } = STATUSES[status]
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium">
      <span className="size-1.5 rounded-full bg-(--swatch)" style={swatch(color)} />
      {label}
    </span>
  )
}

function TicketRow({ ticket, now }: { ticket: OverviewTicket; now: number }) {
  return (
    <li>
      <Link
        href={ticketHref(ticket)}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      >
        <span className="font-mono text-[11px] text-muted-foreground">{ticketRef(ticket.number)}</span>
        <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
        {ticket.pullRequest && <PullRequestIcon state={ticket.pullRequest.state} className="size-3.5" />}
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {ticket.boardName} · {ticket.column}
        </span>
        <time
          dateTime={ticket.since}
          title={`In ${ticket.column} since ${formatDateTime(ticket.since)}`}
          className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
        >
          {formatDuration(now - Date.parse(ticket.since))}
        </time>
      </Link>
    </li>
  )
}

interface AgentListProps {
  agents: OverviewAgent[]
  boards: OverviewBoard[]
  worked: Map<string, number>
  now: number
  /** How many agents are cleared from the list. */
  hidden: number
  onHide: (names: string[]) => void
}

export function AgentList({ agents, boards, worked, now, hidden, onHide }: AgentListProps) {
  const boardNames = new Map(boards.map((board) => [board.id, board.name]))

  if (!agents.length && hidden) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        Every agent is cleared. They come back once they do something on a board.
      </p>
    )
  }

  if (!agents.length) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        Nobody has claimed a ticket in this range. Switch a board’s agent on in its settings, or claim tickets through
        the API.
      </p>
    )
  }

  return (
    <ul className="grid grid-cols-1 gap-3">
      {agents.map((agent) => (
        <li key={agent.name} className="rounded-xl border bg-card p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
            <UserAvatar name={agent.name} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{agent.name}</span>
                <StatusBadge status={agent.status} />
              </div>
              {agent.agentOf.length > 0 && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <BotIcon className="size-3.5" />
                  Host agent for {agent.agentOf.map((boardId) => boardNames.get(boardId)).join(', ')}
                </p>
              )}
            </div>
            <dl className="ml-auto flex gap-5 text-right text-xs">
              <div>
                <dt className="text-muted-foreground">Worked</dt>
                <dd className="font-medium tabular-nums">{formatDuration(worked.get(agent.name) ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Completed</dt>
                <dd className="font-medium tabular-nums">{agent.completed}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last active</dt>
                <dd className="font-medium">
                  {agent.lastActiveAt ? (
                    <time dateTime={agent.lastActiveAt} title={formatDateTime(agent.lastActiveAt)}>
                      {formatRelative(agent.lastActiveAt)}
                    </time>
                  ) : (
                    'Never'
                  )}
                </dd>
              </div>
            </dl>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Clear ${agent.name}`}
              title="Clear from the overview until it does something again"
              className="-mr-1 self-start text-muted-foreground"
              onClick={() => onHide([agent.name])}
            >
              <XIcon />
            </Button>
          </div>
          {agent.tickets.length > 0 && (
            <ul className="mt-2 grid grid-cols-1 border-t pt-2">
              {agent.tickets.map((ticket) => (
                <TicketRow key={ticket.id} ticket={ticket} now={now} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}
