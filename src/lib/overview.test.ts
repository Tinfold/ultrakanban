import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { OverviewActivity } from '@shared/domain'
import { groupAgents, mergeActivity, usageByTag } from './overview.ts'

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

describe('mergeActivity', () => {
  let id = 0
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString()
  const event = (ticketId: string, minutes: number, actor: string, type: string, data: object) =>
    ({
      id: ++id,
      ticketId,
      actor,
      type,
      data,
      createdAt: at(minutes),
      ticket: { number: ticketId === 'a' ? 83 : 51, title: 'T', boardId: 'b', boardName: 'Board' },
    }) as OverviewActivity
  // Oldest first, as they happen; the feed is newest first.
  const feed = (...events: OverviewActivity[]) => events.toReversed()
  const lines = (activity: OverviewActivity[]) =>
    mergeActivity(activity).map((group) => [group.actor, group.verb, group.column, group.events.length])

  test("the loop's claim, move, unassign and assign are one pick-up", () => {
    const activity = feed(
      event('a', 0, 'claude/opus/medium', 'claimed', { assignee: 'claude/opus/medium' }),
      event('a', 0, 'claude/opus/medium', 'moved', { from: 'Todo', to: 'In progress' }),
      event('b', 1, 'someone', 'comment', { body: 'hi' }),
      event('a', 1, 'claude-loop', 'released', { assignee: 'claude/opus/medium' }),
      event('a', 1, 'claude-loop', 'claimed', { assignee: 'claude/opus/high' }),
    )
    assert.deepEqual(lines(activity), [
      ['claude/opus/high', 'picked up', 'In progress', 4],
      ['someone', 'commented on', null, 1],
    ])
    assert.deepEqual(
      mergeActivity(activity)[0].events.map((entry) => entry.type),
      ['claimed', 'moved', 'released', 'claimed'],
    )
  })

  test('a merged pull request and the move to done are one merge', () => {
    const activity = feed(
      event('b', 0, 'github', 'pull_request', { url: 'u', event: 'merged' }),
      event('b', 0, 'github', 'moved', { from: 'Review', to: 'Done' }),
    )
    assert.deepEqual(lines(activity), [['github', 'merged', 'Done', 2]])
  })

  test('other events list what they did; events further apart stay apart', () => {
    const activity = feed(
      event('a', 0, 'ann', 'comment', { body: 'x' }),
      event('a', 1, 'ann', 'moved', { from: 'Todo', to: 'Review' }),
      event('a', 1, 'ann', 'plan', { body: 'p', estimate: 'S', held: false }),
      event('a', 10, 'ann', 'released', { assignee: 'ann' }),
      event('a', 11, 'bob', 'moved', { from: 'Review', to: 'Todo' }),
    )
    assert.deepEqual(lines(activity), [
      ['ann', 'released', 'Todo', 2],
      ['ann', 'commented on and posted a plan for', 'Review', 3],
    ])
  })
})
