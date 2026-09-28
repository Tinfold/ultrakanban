import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ApiErrorBody, BoardDetail, Ticket } from '../shared/domain.ts'
import { addTicket, boardId, call, ticketsIn } from './test-app.ts'

const bulk = (body: Record<string, unknown>) =>
  call<{ tickets: Ticket[] } & ApiErrorBody>('POST', `/boards/${boardId}/tickets/bulk`, body)

const tagNames = async (ticket: Ticket) => {
  const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)
  const names = new Map(board.tags.map((tag) => [tag.id, tag.name]))
  return ticket.tagIds.map((tagId) => names.get(tagId)).sort()
}

describe('bulk ticket changes', () => {
  test('moves tickets, appended in the order given, and skips those already there', async () => {
    const a = await addTicket({ title: 'A' })
    const b = await addTicket({ title: 'B' })
    await addTicket({ title: 'C', column: 'Doing' })

    const res = await bulk({ tickets: [b.id, `#${a.number}`], moveTo: 'Doing' })
    assert.equal(res.status, 200)
    assert.deepEqual(
      res.body.tickets.map((t) => t.title),
      ['B', 'A'],
    )
    assert.deepEqual(
      (await ticketsIn('Doing')).map((t) => t.title),
      ['C', 'B', 'A'],
    )

    const again = await bulk({ tickets: [a.id], moveTo: 'Doing' })
    assert.equal(again.body.tickets[0].version, res.body.tickets[1].version)
  })

  test('sets priority and adds and removes tags, keeping the other tags', async () => {
    const a = await addTicket({ title: 'A', tags: ['bug', 'ui'] })
    const b = await addTicket({ title: 'B', priority: 'high' })

    const res = await bulk({ tickets: [a.id, b.id], priority: 'urgent', addTags: ['api'], removeTags: ['bug'] })
    assert.equal(res.status, 200)
    const [first, second] = res.body.tickets
    assert.equal(first.priority, 'urgent')
    assert.equal(second.priority, 'urgent')
    assert.deepEqual(await tagNames(first), ['api', 'ui'])
    assert.deepEqual(await tagNames(second), ['api'])

    const { body: activity } = await call<{ type: string; actor: string }[]>('GET', `/tickets/${a.id}/activity`)
    assert.equal(activity.at(-1)?.type, 'updated')
    assert.equal(activity.at(-1)?.actor, 'tester')
  })

  test('deletes tickets', async () => {
    const a = await addTicket({ title: 'A' })
    const b = await addTicket({ title: 'B' })
    await addTicket({ title: 'C' })

    const res = await bulk({ tickets: [a.id, b.id], delete: true })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.tickets, [])
    assert.deepEqual(
      (await ticketsIn('Todo')).map((t) => t.title),
      ['C'],
    )
  })

  test('changes nothing when one ticket cannot be changed', async () => {
    await call('PATCH', `/boards/${boardId}`, { doneColumn: 'Done' })
    const a = await addTicket({ title: 'A' })
    const done = await addTicket({ title: 'B', column: 'Done', force: true })
    const noPr = await addTicket({ title: 'C' })

    const res = await bulk({ tickets: [a.id, noPr.id], moveTo: 'Done', priority: 'high' })
    assert.equal(res.status, 409)
    assert.equal(res.body.error.code, 'pull_request_not_merged')
    assert.deepEqual(
      (await ticketsIn('Todo')).map((t) => [t.title, t.priority]),
      [
        ['A', 'none'],
        ['C', 'none'],
      ],
    )

    const forced = await bulk({ tickets: [a.id, noPr.id], moveTo: 'Done', force: true })
    assert.equal(forced.status, 200)
    assert.deepEqual(
      (await ticketsIn('Done')).map((t) => t.id),
      [done.id, a.id, noPr.id],
    )
  })

  test('rejects tickets of another board, unknown tags and requests that change nothing', async () => {
    const a = await addTicket({ title: 'A' })
    const { body: other } = await call<{ id: string }>('POST', '/boards', { name: 'Other', columns: ['Todo'] })
    const elsewhere = (await call<Ticket>('POST', `/boards/${other.id}/tickets`, { title: 'X' })).body

    assert.equal((await bulk({ tickets: [a.id, elsewhere.id], priority: 'low' })).status, 400)
    assert.equal((await bulk({ tickets: [a.id], removeTags: ['nope'] })).status, 404)
    assert.equal((await bulk({ tickets: [a.id] })).status, 400)
    assert.equal((await bulk({ tickets: [a.id], delete: true, priority: 'low' })).status, 400)
    assert.equal((await bulk({ tickets: [], priority: 'low' })).status, 400)
    assert.equal((await call<Ticket>('GET', `/tickets/${a.id}`)).body.priority, 'none')
  })
})
