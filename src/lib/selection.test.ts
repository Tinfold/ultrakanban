import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { BoardDetail, Ticket } from '@shared/domain'
import { bulkChangeTickets } from './board-updates.ts'
import { clickTicket, emptySelection, selectedInOrder } from './selection.ts'

const order = ['a', 'b', 'c', 'd', 'e']

describe('selecting tickets', () => {
  test('a click toggles one ticket', () => {
    const one = clickTicket(emptySelection, order, 'b', false)
    const two = clickTicket(one, order, 'd', false)
    assert.deepEqual([...two.ids], ['b', 'd'])
    assert.deepEqual([...clickTicket(two, order, 'b', false).ids], ['d'])
  })

  test('a shift-click selects the range from the last click, either way', () => {
    const start = clickTicket(emptySelection, order, 'd', false)
    assert.deepEqual(selectedInOrder(clickTicket(start, order, 'b', true), order), ['b', 'c', 'd'])
    const down = clickTicket(clickTicket(emptySelection, order, 'a', false), order, 'c', true)
    assert.deepEqual(selectedInOrder(clickTicket(down, order, 'e', true), order), order)
  })

  test('a shift-click without an anchor toggles', () => {
    assert.deepEqual([...clickTicket(emptySelection, order, 'c', true).ids], ['c'])
  })

  test('bulk actions apply to the visible selected tickets, in board order', () => {
    const selection = { ids: new Set(['e', 'gone', 'a']), anchor: 'a' }
    assert.deepEqual(selectedInOrder(selection, order), ['a', 'e'])
  })
})

describe('bulk changes on the cached board', () => {
  const ticket = (id: string, columnId: string, position: number, tagIds: string[] = []) =>
    ({ id, columnId, position, tagIds, priority: 'none' }) as unknown as Ticket
  const board = { tickets: [ticket('a', 'todo', 0, ['x']), ticket('b', 'todo', 1), ticket('c', 'done', 0)] }
  const detail = board as BoardDetail

  test('sets priority and tags of the given tickets only', () => {
    const next = bulkChangeTickets(detail, ['a', 'b'], { priority: 'high', addTagIds: ['y'], removeTagIds: ['x'] })
    assert.deepEqual(
      next.tickets.map((t) => [t.id, t.priority, t.tagIds]),
      [
        ['a', 'high', ['y']],
        ['b', 'high', ['y']],
        ['c', 'none', []],
      ],
    )
  })

  test('appends moved tickets in the order given', () => {
    const next = bulkChangeTickets(detail, ['b', 'a'], { moveTo: 'done' })
    const done = next.tickets.filter((t) => t.columnId === 'done').sort((x, y) => x.position - y.position)
    assert.deepEqual(
      done.map((t) => t.id),
      ['c', 'b', 'a'],
    )
  })
})
