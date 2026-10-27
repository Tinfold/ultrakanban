import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupAgents, usageByTag } from './overview.ts'

const t = (costUsd: number | null) =>
  ({ tags: [{ name: 'bug', color: 'red' }], usage: { runs: 1, tokens: 10, costUsd } }) as never

test('cost per ticket divides by the tickets that have a cost', () => {
  const [group] = usageByTag([t(4), t(null)], 'cost' as never)
  assert.equal(group.perTicket.costUsd, 4)
  assert.equal(group.perTicket.tokens, 10)
})

test('agents sort working, then waiting for review, then idle, each by last active', () => {
  const a = (name: string, status: string, lastActiveAt: string | null) => ({ name, status, lastActiveAt }) as never
  const { busy, idle } = groupAgents([
    a('idle-old', 'idle', '2026-01-01T00:00:00Z'),
    a('review', 'review', '2026-01-05T00:00:00Z'),
    a('idle-never', 'idle', null),
    a('working-old', 'working', '2026-01-02T00:00:00Z'),
    a('idle-new', 'idle', '2026-01-03T00:00:00Z'),
    a('working-new', 'working', '2026-01-04T00:00:00Z'),
  ])
  const names = (list: { name: string }[]) => list.map((agent) => agent.name)
  assert.deepEqual(names(busy), ['working-new', 'working-old', 'review'])
  assert.deepEqual(names(idle), ['idle-new', 'idle-old', 'idle-never'])
})
