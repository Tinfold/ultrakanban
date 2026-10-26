import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { RoutingComparison, RoutingSourceStats } from '@shared/domain'
import { routingCosts, routingVerdict } from './routing.ts'

const stats = (source: RoutingSourceStats['source'], tickets: number, costPerFinished: number | null) => ({
  source,
  tickets,
  picked: tickets,
  worked: tickets,
  unmeasured: 0,
  finished: tickets,
  successRate: tickets ? 1 : null,
  costUsd: 0,
  weightedTokens: 0,
  costPerFinished,
})

const comparison = (
  sources: RoutingSourceStats[],
  verdict: RoutingComparison['verdict'] = null,
): RoutingComparison => ({
  unit: 'usd',
  sources,
  verdict,
  jev: { calls: 0, costUsd: 0 },
})

describe('routing comparison', () => {
  test('says when there is nothing to compare yet', () => {
    assert.match(routingVerdict(comparison([stats('default', 0, null)])), /^No ticket claimed/)
    assert.match(routingVerdict(comparison([stats('default', 3, 1)])), /^Only the board default/)
    assert.equal(
      routingVerdict(comparison([stats('jev', 4, 0.5), stats('default', 4, 1)])),
      'No verdict until each source has 10 finished tickets.',
    )
  })

  test('names the cheapest source against the others', () => {
    const result = comparison([stats('jev', 12, 0.15), stats('history', 12, 0.2), stats('default', 20, 1)], 'jev')
    assert.equal(
      routingVerdict(result),
      'Jev costs the least per finished ticket: $0.15, against $0.20 for Similar-tickets suggestion and $1.00 for Board default.',
    )
    assert.equal(routingCosts(result), 'Jev $0.15 · Similar-tickets suggestion $0.20 · Board default $1.00')
    assert.equal(
      routingCosts({ ...result, unit: 'tokens', sources: [stats('default', 1, 12_500)] }),
      'Board default 12.5K tokens',
    )
    assert.equal(routingCosts(comparison([stats('default', 0, null)])), null)
  })
})
