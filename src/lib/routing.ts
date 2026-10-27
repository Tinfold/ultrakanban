import { ROUTING_MIN_FINISHED, type RoutedSource, type RoutingComparison } from '@shared/domain'
import { formatCost, formatTokens } from './format.ts'

export const ROUTING_LABELS: Record<RoutedSource, string> = {
  jev: 'Jev',
  history: 'Similar-tickets suggestion',
  default: 'Board default',
}

/** A cost in the comparison's unit: dollars, or tokens weighted by kind when runs reported no cost. */
export const formatRoutingCost = ({ unit }: Pick<RoutingComparison, 'unit'>, value: number) =>
  unit === 'usd' ? formatCost(value) : `${formatTokens(value)} tokens`

/** What the comparison says so far, in one sentence. */
export function routingVerdict(comparison: RoutingComparison) {
  const { sources, verdict } = comparison
  if (!sources.some((source) => source.tickets)) {
    return 'No ticket claimed since routing was recorded has been finished or given up on yet.'
  }
  const best = sources.find((source) => source.source === verdict)
  if (!best || best.costPerFinished === null) {
    return sources.length < 2
      ? 'Only the board default has routed tickets so far: nothing to compare it with.'
      : `No verdict until each source has ${ROUTING_MIN_FINISHED} finished tickets.`
  }
  const others = sources
    .filter((source) => source !== best && source.costPerFinished !== null)
    .map((source) => `${formatRoutingCost(comparison, source.costPerFinished!)} for ${ROUTING_LABELS[source.source]}`)
  return `${ROUTING_LABELS[best.source]} costs the least per finished ticket: ${formatRoutingCost(
    comparison,
    best.costPerFinished,
  )}, against ${others.join(' and ')}.`
}

/** Each source's cost per finished ticket in a line, e.g. `Jev $0.15 · Board default $1.00`; null with none yet. */
export function routingCosts(comparison: RoutingComparison) {
  const costs = comparison.sources.flatMap((source) =>
    source.costPerFinished === null
      ? []
      : [`${ROUTING_LABELS[source.source]} ${formatRoutingCost(comparison, source.costPerFinished)}`],
  )
  return costs.length ? costs.join(' · ') : null
}
