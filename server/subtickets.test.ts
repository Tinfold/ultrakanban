import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import type { ApiErrorBody, Ticket } from '../shared/domain.ts'
import { addTicket, boardId, call, pullRequestStatuses, useBoard } from './test-app.ts'

describe('sub-tickets', () => {
  const PR = 'https://github.com/acme/app/pull/7'

  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Sub-tickets',
      columns: ['Todo', 'In progress', 'Review', 'Done', 'Cancelled'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
    })
    useBoard(body.id)
  })

  const addChild = async (parent: Ticket, input: Record<string, unknown>) =>
    call<Ticket>('POST', `/tickets/${parent.id}/children`, input)
  const getTicket = async (ticket: Ticket) => (await call<Ticket>('GET', `/tickets/${ticket.id}`)).body

  test('creates sub-tickets linked to their parent and counts the finished ones', async () => {
    const parent = await addTicket({ title: 'Big' })
    const first = await addChild(parent, { title: 'Part 1', column: 'Todo', priority: 'high' })
    const second = await addTicket({ title: 'Part 2', parent: `#${parent.number}` })
    const third = await addTicket({ title: 'Part 3', parent: String(parent.number) })

    assert.equal(first.status, 201)
    assert.equal(first.body.parentId, parent.id)
    assert.equal(first.body.priority, 'high')
    assert.equal(second.parentId, parent.id)
    assert.equal(third.parentId, parent.id)
    assert.equal(first.body.subtickets, null)
    assert.deepEqual((await getTicket(parent)).subtickets, { done: 0, total: 3 })

    await call('POST', `/tickets/${first.body.id}/move`, { column: 'Done', force: true })
    await call('POST', `/tickets/${second.id}/review`, { agent: 'a', pullRequest: PR })
    await call('POST', `/tickets/${second.id}/pull-request/sync`)
    assert.deepEqual((await getTicket(parent)).subtickets, { done: 1, total: 3 })

    pullRequestStatuses.set(PR, { state: 'merged', title: 'Part 2' })
    await call('POST', `/tickets/${second.id}/pull-request/sync`)
    assert.deepEqual((await getTicket(parent)).subtickets, { done: 2, total: 3 })

    await call('POST', `/tickets/${third.id}/move`, { column: 'Cancelled' })
    assert.deepEqual((await getTicket(parent)).subtickets, { done: 2, total: 2 })

    const { body: children } = await call<Ticket[]>('GET', `/tickets/${parent.id}/children`)
    assert.deepEqual(children.map((child) => child.title).sort(), ['Part 1', 'Part 2', 'Part 3'])
  })

  test('claim-next skips a parent until its sub-tickets are finished', async () => {
    const parent = await addTicket({ title: 'Big', priority: 'urgent' })
    const child = (await addChild(parent, { title: 'Part', column: 'Todo' })).body
    const claim = () =>
      call<Ticket | ApiErrorBody>('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'a', column: 'Todo' })

    const first = await claim()
    assert.equal((first.body as Ticket).id, child.id)
    const none = await claim()
    assert.equal(none.status, 404)

    await call('POST', `/tickets/${child.id}/move`, { column: 'Done', force: true })
    const next = await claim()
    assert.equal((next.body as Ticket).id, parent.id)
  })

  test('a parent with finished sub-tickets goes to review and done without a pull request', async () => {
    const parent = await addTicket({ title: 'Big' })
    const child = (await addChild(parent, { title: 'Part' })).body

    const early = await call('POST', `/tickets/${parent.id}/review`, { agent: 'a' })
    const earlyDone = await call<ApiErrorBody>('POST', `/tickets/${parent.id}/move`, { column: 'Done' })
    assert.equal(early.status, 400)
    assert.equal(earlyDone.body.error.code, 'pull_request_not_merged')

    await call('POST', `/tickets/${child.id}/move`, { column: 'Done', force: true })
    const review = await call<Ticket>('POST', `/tickets/${parent.id}/review`, { agent: 'a', comment: 'All parts done' })
    const done = await call<Ticket>('POST', `/tickets/${parent.id}/move`, { column: 'Done' })
    assert.equal(review.status, 200)
    assert.equal(done.status, 200)
  })

  test('changes a parent and refuses cycles and other boards', async () => {
    const a = await addTicket({ title: 'A' })
    const b = await addTicket({ title: 'B', parent: a.id })
    const c = await addTicket({ title: 'C', parent: b.id })

    const self = await call('PATCH', `/tickets/${a.id}`, { parent: a.id })
    const cycle = await call('PATCH', `/tickets/${a.id}`, { parent: `#${c.number}` })
    const missing = await call('PATCH', `/tickets/${a.id}`, { parent: '#99' })
    assert.equal(self.status, 400)
    assert.equal(cycle.status, 400)
    assert.equal(missing.status, 404)

    const moved = await call<Ticket>('PATCH', `/tickets/${c.id}`, { parent: a.id })
    assert.equal(moved.body.parentId, a.id)
    assert.equal(moved.body.version, c.version + 1)
    const unlinked = await call<Ticket>('PATCH', `/tickets/${c.id}`, { parent: null })
    assert.equal(unlinked.body.parentId, null)

    const other = (await call<{ id: string }>('POST', '/boards', { name: 'Other', columns: ['Todo'] })).body
    const foreign = await call<Ticket>('POST', `/boards/${other.id}/tickets`, { title: 'X' })
    const crossBoard = await call('PATCH', `/tickets/${foreign.body.id}`, { parent: a.id })
    assert.equal(crossBoard.status, 400)
  })

  test('deleting a parent unlinks its sub-tickets', async () => {
    const parent = await addTicket({ title: 'Big' })
    const child = (await addChild(parent, { title: 'Part' })).body
    await call('DELETE', `/tickets/${parent.id}`)
    assert.equal((await getTicket(child)).parentId, null)
  })

  test('export/import keeps sub-tickets', async () => {
    const parent = await addTicket({ title: 'Big' })
    await addChild(parent, { title: 'Part' })
    const { body: exported } = await call<{ tickets: { title: string; parent: number | null }[] }>(
      'GET',
      `/boards/${boardId}/export`,
    )
    const { body: imported } = await call<{ id: string }>('POST', '/boards/import', exported)
    const { body: reexported } = await call<typeof exported>('GET', `/boards/${imported.id}/export`)

    assert.deepEqual(
      exported.tickets.map((ticket) => ticket.parent),
      [null, 0],
    )
    assert.deepEqual(
      reexported.tickets.map((ticket) => ticket.parent),
      [null, 0],
    )
  })
})
