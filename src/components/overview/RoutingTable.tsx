import type { RoutingComparison, RoutingSourceStats } from '@shared/domain'
import { formatCost } from '@/lib/format'
import { formatRoutingCost, ROUTING_LABELS, routingVerdict } from '@/lib/routing'

const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`)

/** How a source's tickets were counted, for its row's tooltip. */
function countedDetail(source: RoutingSourceStats) {
  const lines = [
    `${source.worked} worked at the setting it picked`,
    `${source.tickets - source.worked} counted at the board's average for its pick`,
  ]
  if (source.source !== 'default') lines.push(`${source.picked} picked by it, the rest by the source it falls back to`)
  if (source.unmeasured) lines.push(`${source.unmeasured} left out: too few tickets decided at its pick`)
  return lines.join('\n')
}

/**
 * Cost per finished ticket of each routing source (Jev's picks, dry run or not, the history suggestion and the
 * board default), on the tickets claimed since routing was recorded.
 */
export function RoutingTable({ routing }: { routing: RoutingComparison }) {
  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-[13px]">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Source
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                Tickets
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                Finished
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                Success
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right font-medium whitespace-nowrap"
                title="Cost divided by success rate"
              >
                Per finished ticket
              </th>
            </tr>
          </thead>
          <tbody>
            {routing.sources.map((source) => (
              <tr key={source.source} className="border-b last:border-0 hover:bg-muted/50">
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {ROUTING_LABELS[source.source]}
                  {routing.verdict === source.source && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">cheapest</span>
                  )}
                </th>
                <td className="px-3 py-2 text-right tabular-nums" title={countedDetail(source)}>
                  {source.tickets}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{source.finished}</td>
                <td className="px-3 py-2 text-right tabular-nums">{percent(source.successRate)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {source.costPerFinished === null ? (
                    <span className="text-muted-foreground/60">—</span>
                  ) : (
                    formatRoutingCost(routing, source.costPerFinished)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {routingVerdict(routing)} Tickets worked at another setting than a source picked count at the board’s average
        for its pick.
        {routing.jev.calls > 0 &&
          ` Jev was asked ${routing.jev.calls} ${routing.jev.calls === 1 ? 'time' : 'times'}, for ${formatCost(
            routing.jev.costUsd,
          )} in all.`}
      </p>
    </div>
  )
}
