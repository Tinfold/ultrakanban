import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type Activity, type ApiErrorBody, type BoardDetail, type Ticket } from '../shared/domain.ts'
import { subscribe } from './events.ts'
import { addTicket, boardId, call, ticketsIn } from './test-app.ts'

describe('tickets', () => {
  test('creates tickets with column/tag names and sequential numbers', async () => {
    const first = await addTicket({ title: 'One', column: 'doing', tags: ['bug', 'Bug', 'ui'], priority: 'high' })
    const second = await addTicket({ title: 'Two' })
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)

    assert.equal(first.number, 1)
    assert.equal(second.number, 2)
    assert.equal(first.columnId, board.columns[1].id)
    assert.equal(second.columnId, board.columns[0].id)
    assert.deepEqual(board.tags.map((tag) => tag.name).sort(), ['bug', 'ui'])
    assert.equal(first.tagIds.length, 2)
  })

  test('moves tickets to a position and reindexes siblings', async () => {
    const a = await addTicket({ title: 'A' })
    await addTicket({ title: 'B' })
    const c = await addTicket({ title: 'C', column: 'Doing' })

    await call('POST', `/tickets/${c.id}/move`, { column: 'Todo', position: 1 })
    assert.deepEqual(
      (await ticketsIn('Todo')).map((t) => t.title),
      ['A', 'C', 'B'],
    )

    await call('POST', `/tickets/${a.id}/move`, { column: 'Todo', position: 2 })
    assert.deepEqual(
      (await ticketsIn('Todo')).map((t) => t.title),
      ['C', 'B', 'A'],
    )
  })

  test('rejects stale writes with ifVersion', async () => {
    const ticket = await addTicket({ title: 'A' })
    const ok = await call<Ticket>('PATCH', `/tickets/${ticket.id}`, { title: 'B', ifVersion: 1 })
    const stale = await call<{ error: { code: string } }>('PATCH', `/tickets/${ticket.id}`, {
      title: 'C',
      ifVersion: 1,
    })

    assert.equal(ok.body.version, 2)
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'version_conflict')
  })

  test('validates input', async () => {
    const res = await call<{ error: { code: string } }>('POST', `/boards/${boardId}/tickets`, { priority: 'meh' })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'validation_error')
  })
})

describe('checklists', () => {
  const description = [
    'Steps:',
    '- [ ] reproduce',
    '```md',
    '- [ ] not a task, just code',
    '```',
    '  * [X] fix it',
    '- [ ] add a test',
  ].join('\n')

  test('lists the checklist items of the description', async () => {
    const ticket = await addTicket({ title: 'A', description })
    const { body } = await call('GET', `/tickets/${ticket.id}/checklist`)

    assert.deepEqual(body, [
      { index: 0, text: 'reproduce', checked: false },
      { index: 1, text: 'fix it', checked: true },
      { index: 2, text: 'add a test', checked: false },
    ])
  })

  test('agents check off one item without rewriting the description', async () => {
    const ticket = await addTicket({ title: 'A', description })
    const checked = await call<Ticket>('POST', `/tickets/${ticket.id}/checklist/2`, {}, 'alpha')
    const unchecked = await call<Ticket>('POST', `/tickets/${ticket.id}/checklist/1`, { checked: false }, 'alpha')
    const again = await call<Ticket>('POST', `/tickets/${ticket.id}/checklist/1`, { checked: false }, 'alpha')
    const { body: activity } = await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)

    assert.equal(checked.body.description, description.replace('- [ ] add a test', '- [x] add a test'))
    assert.equal(unchecked.body.description, checked.body.description.replace('  * [X] fix it', '  * [ ] fix it'))
    assert.equal(again.body.version, unchecked.body.version)
    assert.deepEqual(
      activity.filter((entry) => entry.type === 'checked').map(({ actor, data }) => ({ actor, data })),
      [
        { actor: 'alpha', data: { item: 'add a test', checked: true } },
        { actor: 'alpha', data: { item: 'fix it', checked: false } },
      ],
    )
  })

  test('rejects unknown items and stale versions', async () => {
    const ticket = await addTicket({ title: 'A', description })
    const missing = await call<ApiErrorBody>('POST', `/tickets/${ticket.id}/checklist/3`, {})
    const invalid = await call<ApiErrorBody>('POST', `/tickets/${ticket.id}/checklist/first`, {})
    const stale = await call<ApiErrorBody>('POST', `/tickets/${ticket.id}/checklist/0`, { ifVersion: 9 })

    assert.equal(missing.status, 404)
    assert.equal(invalid.status, 400)
    assert.equal(stale.body.error.code, 'version_conflict')
  })
})

describe('agent claiming', () => {
  test('claim is exclusive until released', async () => {
    const ticket = await addTicket({ title: 'Work' })

    const claimed = await call<Ticket>('POST', `/tickets/${ticket.id}/claim`, { agent: 'alpha', moveTo: 'Doing' })
    const again = await call<Ticket>('POST', `/tickets/${ticket.id}/claim`, { agent: 'alpha' })
    const stolen = await call<{ error: { code: string } }>('POST', `/tickets/${ticket.id}/claim`, { agent: 'beta' })
    const badRelease = await call('POST', `/tickets/${ticket.id}/release`, { agent: 'beta' })
    const released = await call<Ticket>('POST', `/tickets/${ticket.id}/release`, { agent: 'alpha' })
    const reclaimed = await call<Ticket>('POST', `/tickets/${ticket.id}/claim`, { agent: 'beta' })

    assert.equal(claimed.body.assignee, 'alpha')
    assert.equal((await ticketsIn('Doing'))[0].id, ticket.id)
    assert.equal(again.status, 200)
    assert.equal(stolen.status, 409)
    assert.equal(stolen.body.error.code, 'already_claimed')
    assert.equal(badRelease.status, 409)
    assert.equal(released.body.assignee, null)
    assert.equal(reclaimed.body.assignee, 'beta')
  })

  test('claim-next picks by priority, then due date, and never double-assigns', async () => {
    await addTicket({ title: 'low', priority: 'low' })
    await addTicket({ title: 'urgent-late', priority: 'urgent', dueDate: '2030-01-02' })
    await addTicket({ title: 'urgent-soon', priority: 'urgent', dueDate: '2030-01-01' })
    await addTicket({ title: 'tagged', priority: 'medium', tags: ['backend'] })

    const claims = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((agent) =>
        call<Ticket>('POST', `/boards/${boardId}/tickets/claim-next`, { agent, column: 'Todo' }),
      ),
    )
    const titles = claims.filter((res) => res.status === 200).map((res) => res.body.title)

    assert.deepEqual(titles, ['urgent-soon', 'urgent-late', 'tagged', 'low'])
    assert.equal(claims[4].status, 404)
  })

  test('claim-next filters by tag', async () => {
    await addTicket({ title: 'frontend', priority: 'urgent', tags: ['frontend'] })
    await addTicket({ title: 'backend', tags: ['backend'] })

    const res = await call<Ticket>('POST', `/boards/${boardId}/tickets/claim-next`, {
      agent: 'a',
      column: 'Todo',
      tags: ['backend'],
    })
    assert.equal(res.body.title, 'backend')
  })

  test('records activity', async () => {
    const ticket = await addTicket({ title: 'A' })
    await call('POST', `/tickets/${ticket.id}/claim`, { agent: 'alpha', moveTo: 'Done' })
    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Finished' }, 'alpha')
    const { body } = await call<{ type: string }[]>('GET', `/tickets/${ticket.id}/activity`)

    assert.deepEqual(
      body.map((entry) => entry.type),
      ['created', 'claimed', 'moved', 'comment'],
    )
  })
})

describe('boards', () => {
  test('deleting a column can move its tickets elsewhere', async () => {
    await addTicket({ title: 'A', column: 'Doing' })
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)

    const res = await call('DELETE', `/columns/${board.columns[1].id}?moveTicketsTo=Done`)
    const { body: after } = await call<BoardDetail>('GET', `/boards/${boardId}`)

    assert.equal(res.status, 204)
    assert.deepEqual(
      after.columns.map((column) => [column.name, column.position]),
      [
        ['Todo', 0],
        ['Done', 1],
      ],
    )
    assert.equal(after.tickets[0].columnId, after.columns[1].id)
  })

  test('export/import round-trips a board', async () => {
    const ticket = await addTicket({ title: 'A', column: 'Done', tags: ['x'], priority: 'high', agentEffort: 'low' })
    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'hello' })
    const { body: exported } = await call('GET', `/boards/${boardId}/export`)

    const { body: imported } = await call<{ id: string }>('POST', '/boards/import', exported)
    const { body: reexported } = await call('GET', `/boards/${imported.id}/export`)

    assert.deepEqual(reexported, exported)
  })

  test('publishes change events only after commit', async () => {
    const events: string[] = []
    const unsubscribe = subscribe((event) => events.push(event.boardId))
    await addTicket({ title: 'A' })
    await call('POST', `/boards/${boardId}/tickets`, { title: 'B', column: 'missing' })
    unsubscribe()

    assert.deepEqual(events, [boardId])
  })
})
