import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Ticket } from '@shared/domain'
import { activeFilterCount, DEFAULT_VIEW, filterTickets } from './board-view.ts'

const ticket = (over: Partial<Ticket>) =>
  ({ archived: false, title: 't', description: '', tagIds: [], number: 1, assignee: null, ...over }) as Ticket

describe('model, effort and estimate filters', () => {
  const tickets = [
    ticket({ number: 1, agentModel: 'opus', agentEffort: 'high', estimate: 'L' }),
    ticket({ number: 2, agentModel: null, agentEffort: null, estimate: null }),
  ]
  const run = (filter: object) =>
    filterTickets(tickets, { ...DEFAULT_VIEW.filter, ...filter }, '', new Map()).map((t) => t.number)
  test('filters', () => {
    assert.deepEqual(run({ models: ['opus'] }), [1])
    assert.deepEqual(run({ models: [null] }), [2])
    assert.deepEqual(run({ efforts: ['high'] }), [1])
    assert.deepEqual(run({ estimates: [null] }), [2])
    assert.deepEqual(run({}), [1, 2])
  })
  test('counts', () => {
    assert.equal(activeFilterCount({ ...DEFAULT_VIEW.filter, models: ['a'], efforts: ['low'], estimates: ['S'] }), 3)
  })
})
