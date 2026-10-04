import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import type { BoardDetail, Epic, Ticket } from '../shared/domain.ts'
import type { BoardExport } from '../shared/schemas.ts'
import { addTicket, boardId, call, pullRequestStatuses, useBoard } from './test-app.ts'

describe('epics', () => {
  const PR = 'https://github.com/acme/app/pull/8'

  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Epics',
      columns: ['Todo', 'In progress', 'Review', 'Done', 'Cancelled'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
    })
    useBoard(body.id)
  })

  const addEpic = async (input: Record<string, unknown>) =>
    (await call<Epic>('POST', `/boards/${boardId}/epics`, input)).body
  const getEpic = async (epic: Epic) => (await call<Epic>('GET', `/epics/${epic.id}`)).body

  test('creates, lists, edits and deletes epics', async () => {
    const epic = await addEpic({ title: 'Dark mode', description: 'All of it', color: 'violet' })
    assert.equal(epic.title, 'Dark mode')
    assert.equal(epic.color, 'violet')
    assert.deepEqual(epic.progress, { done: 0, total: 0 })
    assert.equal(epic.done, false)

    const duplicate = await call('POST', `/boards/${boardId}/epics`, { title: 'dark MODE' })
    assert.equal(duplicate.status, 409)

    const edited = await call<Epic>('PATCH', `/epics/${epic.id}`, { title: 'Themes', color: 'blue' })
    assert.equal(edited.body.title, 'Themes')
    assert.equal(edited.body.description, 'All of it')

    const ticket = await addTicket({ title: 'Toggle', epic: epic.id })
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    assert.deepEqual(
      board.epics.map((e) => e.title),
      ['Themes'],
    )
    assert.equal(board.tickets.find((t) => t.id === ticket.id)?.epicId, epic.id)

    assert.equal((await call('DELETE', `/epics/${epic.id}`)).status, 204)
    assert.equal((await call('GET', `/epics/${epic.id}`)).status, 404)
    assert.equal((await call<Ticket>('GET', `/tickets/${ticket.id}`)).body.epicId, null)
  })

  test('puts tickets in epics by id or title, creating unknown ones, and filters by them', async () => {
    const epic = await addEpic({ title: 'Search' })
    const first = await addTicket({ title: 'Index', epic: 'search' })
    const second = await addTicket({ title: 'Box', epic: 'Filters' })
    const loose = await addTicket({ title: 'Loose' })
    assert.equal(first.epicId, epic.id)
    const { body: epics } = await call<Epic[]>('GET', `/boards/${boardId}/epics`)
    assert.deepEqual(
      epics.map((e) => e.title),
      ['Search', 'Filters'],
    )
    assert.equal(second.epicId, epics[1].id)

    const moved = await call<Ticket>('PATCH', `/tickets/${loose.id}`, { epic: 'Search' })
    assert.equal(moved.body.epicId, epic.id)
    const { body: activity } = await call<{ type: string; data: { fields?: string[] } }[]>(
      'GET',
      `/tickets/${loose.id}/activity`,
    )
    assert.deepEqual(activity.at(-1)?.data.fields, ['epic'])
    await call('PATCH', `/tickets/${loose.id}`, { epic: null })

    const list = async (query: string) =>
      (await call<Ticket[]>('GET', `/boards/${boardId}/tickets?${query}`)).body.map((t) => t.title).sort()
    assert.deepEqual(await list('epic=Search'), ['Index'])
    assert.deepEqual(await list(`epic=${epics[1].id}`), ['Box'])
    assert.deepEqual(await list('epic=none'), ['Loose'])
    assert.equal((await call('GET', `/boards/${boardId}/tickets?epic=Nope`)).status, 404)

    const bulk = await call<{ tickets: Ticket[] }>('POST', `/boards/${boardId}/tickets/bulk`, {
      tickets: [first.id, loose.id],
      epic: 'Filters',
    })
    assert.deepEqual(
      bulk.body.tickets.map((t) => t.epicId),
      [epics[1].id, epics[1].id],
    )
  })

  test('sub-tickets join their parent epic', async () => {
    const epic = await addEpic({ title: 'Big' })
    const parent = await addTicket({ title: 'Parent', epic: epic.id })
    const child = await call<Ticket>('POST', `/tickets/${parent.id}/children`, { title: 'Child' })
    assert.equal(child.body.epicId, epic.id)
    const other = await call<Ticket>('POST', `/tickets/${parent.id}/children`, { title: 'Other', epic: null })
    assert.equal(other.body.epicId, null)
  })

  test('is done once all its tickets are finished, leaving out cancelled ones', async () => {
    const epic = await addEpic({ title: 'Launch' })
    const first = await addTicket({ title: 'One', epic: epic.id })
    const second = await addTicket({ title: 'Two', epic: epic.id })
    const third = await addTicket({ title: 'Three', epic: epic.id })
    assert.deepEqual((await getEpic(epic)).progress, { done: 0, total: 3 })

    await call('POST', `/tickets/${first.id}/move`, { column: 'Done', force: true })
    await call('POST', `/tickets/${second.id}/review`, { agent: 'a', pullRequest: PR })
    pullRequestStatuses.set(PR, { state: 'merged', title: 'Two' })
    await call('POST', `/tickets/${second.id}/pull-request/sync`)
    assert.deepEqual((await getEpic(epic)).progress, { done: 2, total: 3 })
    assert.equal((await getEpic(epic)).done, false)

    await call('POST', `/tickets/${third.id}/move`, { column: 'Cancelled' })
    const finished = await getEpic(epic)
    assert.deepEqual(finished.progress, { done: 2, total: 2 })
    assert.equal(finished.done, true)
  })

  test('survives export and import', async () => {
    const epic = await addEpic({ title: 'Export me', color: 'teal' })
    await addTicket({ title: 'In it', epic: epic.id })
    await addTicket({ title: 'Not in it' })
    const { body: data } = await call<BoardExport>('GET', `/boards/${boardId}/export`)
    assert.deepEqual(data.epics, [{ title: 'Export me', description: '', color: 'teal' }])

    const { body: imported } = await call<{ id: string }>('POST', '/boards/import', data)
    const { body: board } = await call<BoardDetail>('GET', `/boards/${imported.id}`)
    assert.equal(board.epics.length, 1)
    const byTitle = new Map(board.tickets.map((t) => [t.title, t.epicId]))
    assert.equal(byTitle.get('In it'), board.epics[0].id)
    assert.equal(byTitle.get('Not in it'), null)
  })
})
