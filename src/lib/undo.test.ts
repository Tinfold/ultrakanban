import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'
import type { BoardDetail, Ticket } from '@shared/domain'
import { moveTicket, placementOf, withoutPendingDeletes } from './board-updates.ts'
import { PendingDeletes, pendingDeletes } from './pending-deletes.ts'

const ticket = (id: string, columnId: string, position: number) => ({ id, columnId, position }) as Ticket
const board = (...tickets: Ticket[]) => ({ tickets }) as BoardDetail

const order = (detail: BoardDetail, columnId: string) =>
  detail.tickets
    .filter((t) => t.columnId === columnId)
    .sort((a, b) => a.position - b.position)
    .map((t) => t.id)

describe('undoing a move', () => {
  const before = board(ticket('a', 'todo', 0), ticket('b', 'todo', 1), ticket('c', 'todo', 2), ticket('d', 'done', 0))

  test('placementOf gives the column and index a move back needs', () => {
    assert.deepEqual(placementOf(before, 'b'), { columnId: 'todo', position: 1 })
    assert.equal(placementOf(before, 'missing'), undefined)
  })

  test('moving back to that placement restores both columns', () => {
    const from = placementOf(before, 'b')!
    const moved = moveTicket(before, 'b', 'done', 0)
    assert.deepEqual(order(moved, 'todo'), ['a', 'c'])
    const undone = moveTicket(moved, 'b', from.columnId, from.position)
    assert.deepEqual(order(undone, 'todo'), ['a', 'b', 'c'])
    assert.deepEqual(order(undone, 'done'), ['d'])
  })

  test('undoing a reorder within a column', () => {
    const from = placementOf(before, 'a')!
    const moved = moveTicket(before, 'a', 'todo', 2)
    assert.deepEqual(order(moved, 'todo'), ['b', 'c', 'a'])
    assert.deepEqual(order(moveTicket(moved, 'a', from.columnId, from.position), 'todo'), ['a', 'b', 'c'])
  })
})

describe('undoing a delete', () => {
  afterEach(() => mock.timers.reset())

  test('the delete is only sent after the delay', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const deletes = new PendingDeletes(1000)
    const commit = mock.fn()
    deletes.schedule('a', commit)
    mock.timers.tick(999)
    assert.equal(commit.mock.callCount(), 0)
    assert.ok(deletes.has('a'))
    mock.timers.tick(1)
    assert.equal(commit.mock.callCount(), 1)
    assert.ok(!deletes.has('a'))
  })

  test('undo cancels it, and it is never sent', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const deletes = new PendingDeletes(1000)
    const commit = mock.fn()
    deletes.schedule('a', commit)
    assert.equal(deletes.cancel('a'), true)
    mock.timers.tick(5000)
    assert.equal(deletes.commit('a'), false)
    assert.equal(commit.mock.callCount(), 0)
  })

  test('undo is too late once it was sent, and it is sent once', () => {
    const deletes = new PendingDeletes(1000)
    const commit = mock.fn()
    deletes.schedule('a', commit)
    assert.equal(deletes.commit('a'), true)
    assert.equal(deletes.commit('a'), false)
    assert.equal(deletes.cancel('a'), false)
    assert.equal(commit.mock.callCount(), 1)
  })

  test('flush sends every waiting delete', () => {
    const deletes = new PendingDeletes(1000)
    const commit = mock.fn()
    deletes.schedule('a', commit)
    deletes.schedule('b', commit)
    deletes.flush()
    assert.equal(commit.mock.callCount(), 2)
    assert.ok(!deletes.has('a') && !deletes.has('b'))
  })

  test('a ticket waiting to be deleted stays hidden from the board', () => {
    const detail = board(ticket('a', 'todo', 0), ticket('b', 'todo', 1))
    assert.equal(withoutPendingDeletes(detail), detail)
    pendingDeletes.schedule('a', () => {})
    assert.deepEqual(order(withoutPendingDeletes(detail), 'todo'), ['b'])
    pendingDeletes.cancel('a')
    assert.deepEqual(order(withoutPendingDeletes(detail), 'todo'), ['a', 'b'])
  })
})
