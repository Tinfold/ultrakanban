import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Ticket } from '@shared/domain'
import { activeFilterCount, DEFAULT_VIEW, filterTickets, outsideAgent } from './board-view.ts'

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

describe('outsideAgent', () => {
  const board = { agentEnabled: true, agentName: null }
  const progress = { name: 'In Progress' }
  const held = (assignee: string | null) => ({ assignee })
  test("is whoever holds a ticket in progress that isn't the board's agent", () => {
    assert.equal(outsideAgent(held('codex/gpt-5/high'), board, progress), 'codex/gpt-5/high')
    assert.equal(outsideAgent(held('me'), board, progress), 'me')
    assert.equal(outsideAgent(held('claudette'), board, progress), 'claudette')
  })
  test("is null for the board's agent, its loop and its workers", () => {
    for (const name of ['claude', 'claude-loop', 'claude/opus/high'])
      assert.equal(outsideAgent(held(name), board, progress), null)
    const named = { agentEnabled: true, agentName: 'bot' }
    assert.equal(outsideAgent(held('bot/sonnet/low'), named, progress), null)
    assert.equal(outsideAgent(held('claude/opus/high'), named, progress), 'claude/opus/high')
  })
  test('is null when unassigned, outside the In progress column or on a board without its agent on', () => {
    assert.equal(outsideAgent(held(null), board, progress), null)
    assert.equal(outsideAgent(held('me'), board, { name: 'Todo' }), null)
    assert.equal(outsideAgent(held('me'), board, undefined), null)
    assert.equal(outsideAgent(held('me'), { agentEnabled: false, agentName: null }, progress), null)
  })
})
