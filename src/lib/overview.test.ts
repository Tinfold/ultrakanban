import assert from 'node:assert/strict'
import { test } from 'node:test'
import { overnightStart, usageByTag } from './overview.ts'

const t = (costUsd: number | null) =>
  ({ tags: [{ name: 'bug', color: 'red' }], usage: { runs: 1, tokens: 10, costUsd } }) as never

test('cost per ticket divides by the tickets that have a cost', () => {
  const [group] = usageByTag([t(4), t(null)], 'cost' as never)
  assert.equal(group.perTicket.costUsd, 4)
  assert.equal(group.perTicket.tokens, 10)
})

test('overnight starts at 18:00 yesterday, whatever the time today', () => {
  const start = new Date(2026, 10, 4, 18).getTime()
  for (const hour of [0, 7, 23]) {
    assert.equal(overnightStart(new Date(2026, 10, 5, hour, 30).getTime()).getTime(), start)
  }
})
