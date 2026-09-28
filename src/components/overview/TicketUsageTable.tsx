import { ArrowDownIcon } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { Link } from 'wouter'
import type { OverviewTicketUsage } from '@shared/domain'
import { ColorDot } from '@/components/common/TagChip'
import { Button } from '@/components/ui/button'
import { formatCost, formatTokens, ticketRef } from '@/lib/format'
import { sortTicketUsage, ticketHref, type UsageSort, usageByTag } from '@/lib/overview'
import { cn } from '@/lib/utils'

/** Tickets listed before "Show all". */
const TOP = 10

export type UsageGrouping = 'tickets' | 'tags'

interface TicketUsageTableProps {
  tickets: OverviewTicketUsage[]
  grouping: UsageGrouping
}

const muted = (value: ReactNode) => <span className="text-muted-foreground/60">{value}</span>

function SortHeader({
  sort,
  current,
  onSort,
  children,
}: {
  sort: UsageSort
  current: UsageSort
  onSort: (sort: UsageSort) => void
  children: ReactNode
}) {
  const active = sort === current
  return (
    <th
      scope="col"
      className="px-3 py-2 text-right font-medium whitespace-nowrap"
      aria-sort={active ? 'descending' : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(sort)}
        className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground')}
      >
        {children}
        {active && <ArrowDownIcon className="size-3" />}
      </button>
    </th>
  )
}

export function TicketUsageTable({ tickets, grouping }: TicketUsageTableProps) {
  const [sort, setSort] = useState<UsageSort>('tokens')
  const [showAll, setShowAll] = useState(false)
  const sorted = useMemo(() => sortTicketUsage(tickets, sort), [tickets, sort])
  const tags = useMemo(() => usageByTag(tickets, sort), [tickets, sort])

  if (tickets.length === 0) {
    return (
      <p className="rounded-xl border bg-card px-3 py-6 text-center text-sm text-muted-foreground">No agent runs</p>
    )
  }

  const header = (label: string) => (
    <th scope="col" className="sticky left-0 bg-card px-3 py-2 text-left font-medium sm:static sm:bg-transparent">
      {label}
    </th>
  )
  const sortHeaders = (suffix: string) => (
    <>
      <SortHeader sort="tokens" current={sort} onSort={setSort}>
        Tokens{suffix}
      </SortHeader>
      <SortHeader sort="cost" current={sort} onSort={setSort}>
        Cost{suffix}
      </SortHeader>
      <SortHeader sort="runs" current={sort} onSort={setSort}>
        Runs{suffix}
      </SortHeader>
    </>
  )
  const usageCells = (usage: OverviewTicketUsage['usage']) => (
    <>
      <td className="px-3 py-2 text-right tabular-nums" title={`${Math.round(usage.tokens).toLocaleString()} tokens`}>
        {formatTokens(usage.tokens)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {usage.costUsd === null ? muted('—') : formatCost(usage.costUsd)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{Number(usage.runs.toFixed(1))}</td>
    </>
  )

  if (grouping === 'tags') {
    return (
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-[13px]">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              {header('Tag')}
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Tickets
              </th>
              {sortHeaders(' / ticket')}
            </tr>
          </thead>
          <tbody>
            {tags.map((group) => (
              <tr key={group.tag?.name ?? ''} className="border-b last:border-0 hover:bg-muted/50">
                <th
                  scope="row"
                  className="sticky left-0 bg-card px-3 py-2 text-left font-medium sm:static sm:bg-transparent"
                >
                  {group.tag ? (
                    <span className="inline-flex items-center gap-1.5">
                      <ColorDot color={group.tag.color} />
                      {group.tag.name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No tags</span>
                  )}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">{group.tickets}</td>
                {usageCells(group.perTicket)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const shown = showAll ? sorted : sorted.slice(0, TOP)
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-[13px]">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            {header('Ticket')}
            {sortHeaders('')}
          </tr>
        </thead>
        <tbody>
          {shown.map((ticket) => (
            <tr key={ticket.id} className="border-b last:border-0 hover:bg-muted/50">
              <th
                scope="row"
                className="sticky left-0 max-w-[28rem] bg-card px-3 py-2 text-left font-normal sm:static sm:bg-transparent"
              >
                <Link href={ticketHref(ticket)} className="flex min-w-0 items-baseline gap-1.5 hover:underline">
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {ticketRef(ticket.number)}
                  </span>
                  <span className="truncate font-medium">{ticket.title}</span>
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>
                    {ticket.boardName} · {ticket.column}
                  </span>
                  {ticket.tags.map((tag) => (
                    <span key={tag.id} className="inline-flex items-center gap-1">
                      <ColorDot color={tag.color} className="size-1.5" />
                      {tag.name}
                    </span>
                  ))}
                </div>
              </th>
              {usageCells(ticket.usage)}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > TOP && (
        <div className="border-t px-3 py-1.5">
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${sorted.length}`}
          </Button>
        </div>
      )}
    </div>
  )
}
