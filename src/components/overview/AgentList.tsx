import { BotIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import { Link } from 'wouter'
import { type Color, type OverviewAgent, type OverviewBoard, type OverviewTicket, totalTokens } from '@shared/domain'
import { PullRequestIcon } from '@/components/common/PullRequestIcon'
import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useStoredState } from '@/hooks/use-stored-state'
import { swatch } from '@/lib/colors'
import {
  COST_NOTE,
  formatCost,
  formatDateTime,
  formatDuration,
  formatModel,
  formatRelative,
  formatTokens,
  ticketRef,
} from '@/lib/format'
import { groupAgents, modelsByTokens, ticketHref } from '@/lib/overview'
import { storageKeys } from '@/lib/storage'
import { cn } from '@/lib/utils'

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

function usageSummary({ usage }: OverviewAgent) {
  const runs = `${usage.runs} ${usage.runs === 1 ? 'run' : 'runs'}`
  return [
    usage.costUsd === null ? runs : `${runs}, ${formatCost(usage.costUsd)} estimated`,
    `Input: ${usage.inputTokens.toLocaleString()}`,
    `Output: ${usage.outputTokens.toLocaleString()}`,
    `Cache writes: ${usage.cacheWriteTokens.toLocaleString()}`,
    `Cache reads: ${usage.cacheReadTokens.toLocaleString()}`,
    // Then the tokens each model used, after a blank line.
    ...modelsByTokens(usage).flatMap((entry, i) => [
      ...(i ? [] : ['']),
      `${formatModel(entry.model)}: ${totalTokens(entry).toLocaleString()}`,
    ]),
  ].join('\n')
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

function LastActive({ agent }: { agent: OverviewAgent }) {
  return agent.lastActiveAt ? (
    <time dateTime={agent.lastActiveAt} title={formatDateTime(agent.lastActiveAt)}>
      {formatRelative(agent.lastActiveAt)}
    </time>
  ) : (
    'Never'
  )
}

/** The boards an agent is the host agent of: the name of one, else how many, named in a tooltip. */
function HostOf({ agent, boardNames }: { agent: OverviewAgent; boardNames: Map<string, string> }) {
  const names = agent.agentOf.map((boardId) => boardNames.get(boardId) ?? boardId)
  if (!names.length) return null
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <BotIcon className="size-3.5 shrink-0" />
      {names.length === 1 ? (
        <span className="truncate">Host agent for {names[0]}</span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="cursor-default underline decoration-dotted underline-offset-2">
              Hosts {names.length} boards
            </span>
          </TooltipTrigger>
          <TooltipContent className="flex-col items-start gap-0.5 py-2" side="bottom" align="start">
            {names.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
    </p>
  )
}

function HideButton({ agent, onHide }: { agent: OverviewAgent; onHide: (names: string[]) => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`Clear ${agent.name}`}
      title="Clear from the overview until it does something again"
      className="-mr-1 shrink-0 text-muted-foreground"
      onClick={() => onHide([agent.name])}
    >
      <XIcon />
    </Button>
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
  const [idleOpen, setIdleOpen] = useStoredState(storageKeys.overviewIdleAgents, false)
  const { busy, idle } = groupAgents(agents)

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
    <div className="grid grid-cols-1 gap-3">
      {busy.length > 0 && (
        <ul className="grid grid-cols-1 gap-3">
          {busy.map((agent) => (
            <li key={agent.name} className="rounded-xl border bg-card p-3">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-1">
                <UserAvatar name={agent.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{agent.name}</span>
                    <StatusBadge status={agent.status} />
                  </div>
                  <HostOf agent={agent} boardNames={boardNames} />
                </div>
                {/* Fixed column widths, so the stats line up from one card to the next. */}
                <dl className="order-last grid w-full grid-cols-3 gap-x-3 gap-y-1.5 text-xs sm:order-none sm:w-auto sm:grid-cols-[4rem_4.5rem_4.5rem_4.5rem_7rem] sm:text-right">
                  <div>
                    <dt className="text-muted-foreground">Worked</dt>
                    <dd className="font-medium tabular-nums">{formatDuration(worked.get(agent.name) ?? 0)}</dd>
                  </div>
                  <div title={usageSummary(agent)}>
                    <dt className="text-muted-foreground">Tokens</dt>
                    <dd className="font-medium tabular-nums">{formatTokens(totalTokens(agent.usage))}</dd>
                  </div>
                  <div title={COST_NOTE}>
                    <dt className="text-muted-foreground">Est. cost</dt>
                    <dd className="font-medium tabular-nums">
                      {agent.usage.costUsd === null ? '—' : formatCost(agent.usage.costUsd)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Completed</dt>
                    <dd className="font-medium tabular-nums">{agent.completed}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Last active</dt>
                    <dd className="font-medium">
                      <LastActive agent={agent} />
                    </dd>
                  </div>
                </dl>
                <HideButton agent={agent} onHide={onHide} />
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
      )}
      {idle.length > 0 && (
        <div className="rounded-xl border bg-card">
          <button
            type="button"
            aria-expanded={idleOpen}
            onClick={() => setIdleOpen(!idleOpen)}
            className="flex w-full items-center gap-2 rounded-xl px-4 py-2.5 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon className={cn('size-4 text-muted-foreground', idleOpen && 'rotate-90')} />
            {idle.length} idle {idle.length === 1 ? 'agent' : 'agents'}
          </button>
          {idleOpen && (
            <ul className="grid grid-cols-1 border-t px-2 py-1.5">
              {idle.map((agent) => (
                <li key={agent.name} className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px]">
                  <UserAvatar name={agent.name} size="xs" />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <StatusBadge status={agent.status} />
                  <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">
                    <LastActive agent={agent} />
                  </span>
                  <HideButton agent={agent} onHide={onHide} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
