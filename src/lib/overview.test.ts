import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usageByTag } from './overview.ts'

const t = (costUsd: number | null) =>
  ({ tags: [{ name: 'bug', color: 'red' }], usage: { runs: 1, tokens: 10, costUsd } }) as never

test('cost per ticket divides by the tickets that have a cost', () => {
  const [group] = usageByTag([t(4), t(null)], 'cost' as never)
  assert.equal(group.perTicket.costUsd, 4)
  assert.equal(group.perTicket.tokens, 10)
})
