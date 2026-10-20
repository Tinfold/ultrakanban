import assert from 'node:assert/strict'
import { beforeEach, describe, mock, test } from 'node:test'
import {
  type Activity,
  AGENT_IDLE_MINUTES,
  type ApiErrorBody,
  type BoardDetail,
  RUN_MAX_STEPS,
  RUN_MESSAGE_MAX,
  RUN_RECORDS_KEPT,
  type RunRecord,
  type Ticket,
} from '../shared/domain.ts'
import { subscribe, subscribeWake } from './events.ts'
import { addTicket, boardId, call, ticketsIn, useBoard } from './test-app.ts'

/** The boards `fn` wakes the agent of (`wake` events), in order. */
async function wakes(fn: () => Promise<unknown>) {
  const boards: string[] = []
  const unsubscribe = subscribeWake((event) => boards.push(event.boardId))
  try {
    await fn()
  } finally {
    unsubscribe()
  }
  return boards
}

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

  test('claim-next takes equally important tickets in board order', async () => {
    await addTicket({ title: 'first', priority: 'high' })
    await addTicket({ title: 'second', priority: 'high' })
    const third = await addTicket({ title: 'third', priority: 'high' })
    await call('POST', `/tickets/${third.id}/move`, { column: 'Todo', position: 0 })

    const titles = []
    for (const agent of ['a', 'b', 'c']) {
      titles.push(
        (await call<Ticket>('POST', `/boards/${boardId}/tickets/claim-next`, { agent, column: 'Todo' })).body.title,
      )
    }

    assert.deepEqual(titles, ['third', 'first', 'second'])
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

  test('claim-next skips blocked tickets', async () => {
    const blocker = await addTicket({ title: 'blocker', column: 'Doing' })
    await addTicket({ title: 'tagged', priority: 'urgent', tags: ['Blocked'] })
    await addTicket({ title: 'waiting', priority: 'high', description: `Depends on #99 and #${blocker.number}.` })
    await addTicket({ title: 'fenced', priority: 'medium', description: '```\nblocked by #1\n```' })
    await addTicket({ title: 'free', priority: 'low' })

    const claim = () => call<Ticket>('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'a', column: 'Todo' })
    assert.equal((await claim()).body.title, 'fenced')
    assert.equal((await claim()).body.title, 'free')
    assert.equal((await claim()).status, 404)

    await call('POST', `/tickets/${blocker.id}/move`, { column: 'Done' })
    assert.equal((await claim()).body.title, 'waiting')
  })

  test('claiming a specific ticket refuses blocked ones', async () => {
    const blocker = await addTicket({ title: 'blocker', column: 'Doing' })
    const tagged = await addTicket({ title: 'tagged', tags: ['blocked'] })
    const waiting = await addTicket({ title: 'waiting', description: `Blocked by #${blocker.number}` })
    const parent = await addTicket({ title: 'parent' })
    await call('POST', `/tickets/${parent.id}/children`, { title: 'child', column: 'Todo' })

    const claim = (id: string, agent = 'a') => call<Ticket & ApiErrorBody>('POST', `/tickets/${id}/claim`, { agent })
    for (const ticket of [tagged, waiting, parent]) {
      const refused = await claim(ticket.id)
      assert.equal(refused.status, 409)
      assert.equal(refused.body.error.code, 'blocked')
      assert.equal((await call<Ticket>('GET', `/tickets/${ticket.id}`)).body.assignee, null)
    }

    await call('POST', `/tickets/${blocker.id}/move`, { column: 'Done' })
    assert.equal((await claim(waiting.id)).status, 200)

    // A ticket an agent already holds stays claimable by it, even once it is blocked.
    await call('PATCH', `/tickets/${waiting.id}`, { tags: ['blocked'] })
    assert.equal((await claim(waiting.id)).status, 200)
    assert.equal((await claim(waiting.id, 'b')).body.error.code, 'already_claimed')
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

describe('idle tickets', () => {
  /** Runs `fn` with the clock moved forward by the given minutes. */
  async function later<T>(minutes: number, fn: () => Promise<T>) {
    mock.timers.enable({ apis: ['Date'], now: Date.now() + minutes * 60_000 })
    try {
      return await fn()
    } finally {
      mock.timers.reset()
    }
  }

  const doingColumn = async () =>
    (await call<BoardDetail>('GET', `/boards/${boardId}`)).body.columns.find((column) => column.name === 'Doing')!

  test('lists tickets without a recent heartbeat or activity, and moves them back unassigned', async () => {
    const idle = await addTicket({ title: 'Idle' })
    const running = await addTicket({ title: 'Running' })
    const discussed = await addTicket({ title: 'Discussed' })
    for (const ticket of [idle, running, discussed]) {
      await call('POST', `/tickets/${ticket.id}/claim`, { agent: 'alpha', moveTo: 'Doing' })
    }
    const column = await doingColumn()

    const fresh = await call<Ticket[]>('GET', `/columns/${column.id}/idle-tickets`)
    assert.deepEqual(fresh.body, [])

    const minutes = AGENT_IDLE_MINUTES + 1
    const released = await later(minutes, async () => {
      assert.equal((await call('POST', `/tickets/${running.id}/heartbeat`, undefined, 'alpha')).status, 204)
      await call('POST', `/tickets/${discussed.id}/comments`, { body: 'Still on it' }, 'alpha')
      const listed = await call<Ticket[]>('GET', `/columns/${column.id}/idle-tickets`)
      assert.deepEqual(
        listed.body.map((ticket) => ticket.title),
        ['Idle'],
      )
      return call<Ticket[]>('POST', `/columns/${column.id}/release-idle`, { moveTo: 'Todo' })
    })

    assert.equal(released.status, 200)
    assert.deepEqual(
      released.body.map((ticket) => [ticket.title, ticket.assignee]),
      [['Idle', null]],
    )
    assert.deepEqual(
      (await ticketsIn('Todo')).map((ticket) => ticket.title),
      ['Idle'],
    )
    const { body: activity } = await call<Activity[]>('GET', `/tickets/${idle.id}/activity`)
    assert.deepEqual(
      activity.slice(-2).map((entry) => entry.type),
      ['released', 'moved'],
    )
  })

  test('releasing into the done column skips tickets that cannot enter it instead of failing the batch', async () => {
    await call('PATCH', `/boards/${boardId}`, { doneColumn: 'Done' })
    const stuck = await addTicket({ title: 'Stuck' })
    const asked = await addTicket({ title: 'Asked', tags: ['question'] })
    for (const ticket of [stuck, asked]) {
      await call('POST', `/tickets/${ticket.id}/claim`, { agent: 'alpha', moveTo: 'Doing' })
    }
    const column = await doingColumn()

    const released = await later(AGENT_IDLE_MINUTES + 1, () =>
      call<Ticket[]>('POST', `/columns/${column.id}/release-idle`, { moveTo: 'Done' }),
    )

    assert.equal(released.status, 200)
    assert.deepEqual(
      released.body.map((ticket) => ticket.title),
      ['Asked'],
    )
    assert.deepEqual(
      (await ticketsIn('Doing')).map((ticket) => [ticket.title, ticket.assignee]),
      [['Stuck', 'alpha']],
    )
  })

  test('a heartbeat is not a change to the ticket', async () => {
    const ticket = await addTicket({ title: 'A' })
    await call('POST', `/tickets/${ticket.id}/heartbeat`)
    const { body } = await call<Ticket>('GET', `/tickets/${ticket.id}`)

    assert.equal(body.version, ticket.version)
    assert.equal((await call('POST', '/tickets/missing/heartbeat')).status, 404)
  })

  test('shows the run working a ticket, from its first heartbeat until it ends', async () => {
    const ticket = await addTicket({ title: 'A' })
    const run = async () => (await call<Ticket>('GET', `/tickets/${ticket.id}`)).body.run
    const events: string[] = []
    const unsubscribe = subscribe((event) => events.push(event.boardId))
    assert.equal(ticket.run, null)

    await call('POST', `/tickets/${ticket.id}/heartbeat`, { step: 'Working the ticket' })
    const started = await run()
    assert.equal(started?.step, 'Working the ticket')
    assert.equal(started?.seenAt, started?.startedAt)

    const later1 = await later(1, async () => {
      // Without a step, a heartbeat keeps the run's step, and nothing changes that boards need to show.
      assert.equal((await call('POST', `/tickets/${ticket.id}/heartbeat`)).status, 204)
      return run()
    })
    assert.equal(later1?.startedAt, started?.startedAt)
    assert.equal(later1?.step, 'Working the ticket')
    assert.ok(later1!.seenAt > started!.seenAt)
    assert.equal(events.length, 1)

    await call('POST', `/tickets/${ticket.id}/heartbeat`, { step: 'Fixing CI' })
    assert.equal((await run())?.step, 'Fixing CI')
    assert.equal((await run())?.tokens, null)
    assert.equal(events.length, 2)

    // The tokens a run has used so far change what boards show, and a heartbeat without them keeps them.
    await call('POST', `/tickets/${ticket.id}/heartbeat`, { tokens: 120_000 })
    await call('POST', `/tickets/${ticket.id}/heartbeat`, { step: 'Fixing CI' })
    assert.deepEqual(await run().then((current) => [current?.step, current?.tokens]), ['Fixing CI', 120_000])
    assert.equal(events.length, 3)

    assert.equal((await call('DELETE', `/tickets/${ticket.id}/heartbeat`)).status, 204)
    assert.equal(await run(), null)
    assert.equal(events.length, 4)
    unsubscribe()
    assert.equal((await call('DELETE', '/tickets/missing/heartbeat')).status, 404)
    assert.equal((await call('POST', `/tickets/${ticket.id}/heartbeat`, { step: 'x'.repeat(201) })).status, 400)
  })

  test('a run without a heartbeat for a while is over, and the next heartbeat starts a new one', async () => {
    const ticket = await addTicket({ title: 'A' })
    await call('POST', `/tickets/${ticket.id}/heartbeat`, { step: 'Working the ticket' })
    const started = (await call<Ticket>('GET', `/tickets/${ticket.id}`)).body.run!

    const minutes = AGENT_IDLE_MINUTES + 1
    const [stale, restarted] = await later(minutes, async () => {
      const stale = (await call<Ticket>('GET', `/tickets/${ticket.id}`)).body.run
      await call('POST', `/tickets/${ticket.id}/heartbeat`)
      return [stale, (await call<Ticket>('GET', `/tickets/${ticket.id}`)).body.run]
    })
    assert.equal(stale, null)
    assert.ok(restarted!.startedAt > started.startedAt)
    assert.equal(restarted!.step, null)
  })

  test('records who asked a run to stop, and wakes the agent up, until the run ends', async () => {
    const ticket = await addTicket({ title: 'A' })
    const stop = (actor = 'person') =>
      call<Ticket & ApiErrorBody>('POST', `/tickets/${ticket.id}/stop`, undefined, actor)
    const get = async () => (await call<Ticket>('GET', `/tickets/${ticket.id}`)).body
    const activity = async () => (await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)).body

    const idle = await stop()
    assert.equal(idle.status, 409)
    assert.equal(idle.body.error.code, 'no_run')

    await call('POST', `/tickets/${ticket.id}/heartbeat`, { step: 'Working the ticket' }, 'alpha')
    assert.equal((await get()).run?.stopRequested, null)
    let stopped: Awaited<ReturnType<typeof stop>> | undefined
    assert.deepEqual(await wakes(async () => void (stopped = await stop())), [boardId])
    assert.equal(stopped?.status, 200)
    assert.equal(stopped?.body.run?.stopRequested?.by, 'person')
    assert.ok(stopped?.body.run?.stopRequested?.at)
    // Not a change to the ticket itself, but its activity says who stopped the run, and what the run was doing.
    assert.equal(stopped?.body.version, ticket.version)
    const entry = (await activity()).at(-1)!
    assert.deepEqual([entry.type, entry.actor, entry.data], ['stopped', 'person', { step: 'Working the ticket' }])

    // Asking again before the run stops changes nothing.
    const again = await stop('someone else')
    assert.equal(again.body.run?.stopRequested?.by, 'person')
    assert.equal((await activity()).filter((item) => item.type === 'stopped').length, 1)

    // The run's heartbeats keep the request; its end clears it, and the next run starts without one.
    await call('POST', `/tickets/${ticket.id}/heartbeat`, undefined, 'alpha')
    assert.equal((await get()).run?.stopRequested?.by, 'person')
    await call('DELETE', `/tickets/${ticket.id}/heartbeat`, undefined, 'alpha')
    assert.equal((await get()).run, null)
    await call('POST', `/tickets/${ticket.id}/heartbeat`, undefined, 'alpha')
    assert.equal((await get()).run?.stopRequested, null)

    assert.equal((await call('POST', '/tickets/missing/stop')).status, 404)
  })

  test('a run that went quiet takes its stop request with it', async () => {
    const ticket = await addTicket({ title: 'A' })
    await call('POST', `/tickets/${ticket.id}/heartbeat`, undefined, 'alpha')
    // A body is ignored.
    assert.equal((await call('POST', `/tickets/${ticket.id}/stop`, {}, 'person')).status, 200)

    const minutes = AGENT_IDLE_MINUTES + 1
    const [quiet, next] = await later(minutes, async () => {
      const quiet = await call<ApiErrorBody>('POST', `/tickets/${ticket.id}/stop`, undefined, 'person')
      await call('POST', `/tickets/${ticket.id}/heartbeat`, undefined, 'alpha')
      return [quiet, (await call<Ticket>('GET', `/tickets/${ticket.id}`)).body.run] as const
    })
    assert.equal(quiet.status, 409)
    assert.equal(next?.stopRequested, null)
  })

  test('refuses to move idle tickets into their own column', async () => {
    const column = await doingColumn()
    const res = await call('POST', `/columns/${column.id}/release-idle`, { moveTo: 'Doing' })
    assert.equal(res.status, 400)
  })
})

describe('waking the agent up', () => {
  const AGENT = 'claude/opus/high'

  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Agent',
      columns: ['Todo', 'In progress', 'Review', 'Done'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
      approvalSize: 'M',
    })
    useBoard(body.id)
  })

  /** A Todo ticket the agent claims into In progress, which doesn't wake it up: it did that itself. */
  async function claimed() {
    const ticket = await addTicket({ title: 'Work', column: 'Todo' })
    let claim: Ticket | undefined
    const woken = await wakes(async () => {
      const body = { agent: AGENT, moveTo: 'In progress' }
      claim = (await call<Ticket>('POST', `/tickets/${ticket.id}/claim`, body, AGENT)).body
    })
    assert.deepEqual(woken, [])
    return claim!
  }
  const comment = (ticketId: string, actor: string) =>
    call('POST', `/tickets/${ticketId}/comments`, { body: 'Use the other API' }, actor)
  const move = (ticket: Ticket, column: string, actor: string) =>
    call('POST', `/tickets/${ticket.id}/move`, { column }, actor)

  test("someone's comment on a ticket the agent holds wakes it up; the agent's own comments don't", async () => {
    const ticket = await claimed()
    assert.deepEqual(await wakes(() => comment(ticket.id, 'person')), [boardId])
    // The agent's comments, its loop's notes and its other workers' are its own, as the agent loop tells them apart.
    for (const actor of [AGENT, 'claude', 'claude-loop', 'claude/sonnet/low']) {
      assert.deepEqual(await wakes(() => comment(ticket.id, actor)), [], actor)
    }
    // Another agent's comment is feedback like a person's.
    assert.deepEqual(await wakes(() => comment(ticket.id, 'codex/gpt/high')), [boardId])
    // No agent waits for comments on a ticket nobody holds.
    const free = await addTicket({ title: 'Free' })
    assert.deepEqual(await wakes(() => comment(free.id, 'person')), [])
  })

  test('approving the plan and moving the ticket back into In progress wake the agent up', async () => {
    const ticket = await claimed()
    await call('POST', `/tickets/${ticket.id}/plan`, { agent: AGENT, estimate: 'L', plan: 'A big change' }, AGENT)
    assert.deepEqual(await wakes(() => call('POST', `/tickets/${ticket.id}/approve`, undefined, 'person')), [boardId])

    // Moves into other columns aren't feedback, and neither are the agent's own.
    assert.deepEqual(await wakes(() => move(ticket, 'Review', AGENT)), [])
    assert.deepEqual(await wakes(() => move(ticket, 'In progress', AGENT)), [])
    assert.deepEqual(await wakes(() => move(ticket, 'Review', 'person')), [])
    assert.deepEqual(await wakes(() => move(ticket, 'In progress', 'person')), [boardId])

    // Moving several tickets back at once wakes it up once.
    const other = await claimed()
    const bulk = { tickets: [ticket.id, other.id], moveTo: 'Review' }
    assert.deepEqual(await wakes(() => call('POST', `/boards/${boardId}/tickets/bulk`, bulk, 'person')), [])
    assert.deepEqual(
      await wakes(() => call('POST', `/boards/${boardId}/tickets/bulk`, { ...bulk, moveTo: 'in progress' }, 'person')),
      [boardId],
    )
  })

  test('a change that fails wakes nobody up', async () => {
    const ticket = await claimed()
    await move(ticket, 'Review', 'person')
    const stale = { column: 'In progress', ifVersion: ticket.version }
    const response = await wakes(async () => {
      assert.equal((await call('POST', `/tickets/${ticket.id}/move`, stale, 'person')).status, 409)
    })
    assert.deepEqual(response, [])
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

  test('deleting a column with tickets needs moveTicketsTo or deleteTickets', async () => {
    await addTicket({ title: 'A', column: 'Doing' })
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    const id = board.columns[1].id

    const refused = await call('DELETE', `/columns/${id}`)
    assert.equal(refused.status, 409)
    const deleted = await call('DELETE', `/columns/${id}?deleteTickets=true`)
    const { body: after } = await call<BoardDetail>('GET', `/boards/${boardId}`)

    assert.equal(deleted.status, 204)
    assert.equal(after.tickets.length, 0)
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

describe('ticket search', () => {
  test('matches the search text literally, not as LIKE wildcards', async () => {
    await addTicket({ title: 'Half of it is done 50% now' })
    await addTicket({ title: 'Five hundred' })
    await addTicket({ title: 'Snake_case name' })
    await addTicket({ title: 'Snakexcase name' })
    await addTicket({ title: 'Back\\slash' })
    await addTicket({ title: 'Backxslash' })

    const titles = async (q: string) =>
      (await call<Ticket[]>('GET', `/boards/${boardId}/tickets?q=${encodeURIComponent(q)}`)).body.map((t) => t.title)

    assert.deepEqual(await titles('50%'), ['Half of it is done 50% now'])
    assert.deepEqual(await titles('snake_case'), ['Snake_case name'])
    assert.deepEqual(await titles('Back\\slash'), ['Back\\slash'])
  })
})

describe('archiving done tickets', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  /** Runs `fn` with the clock moved forward by the given days. */
  async function later<T>(days: number, fn: () => Promise<T>) {
    mock.timers.enable({ apis: ['Date'], now: Date.now() + days * DAY_MS })
    try {
      return await fn()
    } finally {
      mock.timers.reset()
    }
  }

  const titles = (tickets: Ticket[]) => tickets.map((ticket) => ticket.title).sort()

  async function setUp() {
    await call('PATCH', `/boards/${boardId}`, { doneColumn: 'Done', archiveDoneDays: 7 })
    const done = await addTicket({ title: 'Done', column: 'Doing' })
    await call('POST', `/tickets/${done.id}/move`, { column: 'Done', force: true })
    await addTicket({ title: 'Doing', column: 'Doing' })
    return done
  }

  test('leaves tickets done for longer than the board setting out of the board', async () => {
    await setUp()

    const board = await later(8, () => call<BoardDetail>('GET', `/boards/${boardId}`))
    assert.equal(board.body.board.archiveDoneDays, 7)
    assert.deepEqual(titles(board.body.tickets), ['Doing'])
    assert.equal(board.body.archivedCount, 1)

    const all = await later(8, () => call<BoardDetail>('GET', `/boards/${boardId}?archived=true`))
    assert.deepEqual(all.body.tickets.map((ticket) => [ticket.title, ticket.archived]).sort(), [
      ['Doing', false],
      ['Done', true],
    ])
    assert.equal(all.body.archivedCount, 0)

    const recent = await later(6, () => call<BoardDetail>('GET', `/boards/${boardId}`))
    assert.deepEqual(titles(recent.body.tickets), ['Doing', 'Done'])
  })

  test('keeps archived tickets in the ticket list and search', async () => {
    const done = await setUp()

    const search = await later(8, () => call<Ticket[]>('GET', `/boards/${boardId}/tickets?q=done`))
    assert.deepEqual(titles(search.body), ['Done'])
    assert.equal(search.body[0].archived, true)
    assert.equal((await later(8, () => call<Ticket>('GET', `/tickets/${done.id}`))).body.archived, true)
  })

  test('counts from when the ticket entered the done column, and never archives without the setting', async () => {
    const old = await addTicket({ title: 'Old', column: 'Doing' })
    await later(30, async () => {
      await call('PATCH', `/boards/${boardId}`, { doneColumn: 'Done', archiveDoneDays: 7 })
      const moved = await call<Ticket>('POST', `/tickets/${old.id}/move`, { column: 'Done', force: true })
      assert.equal(moved.body.archived, false)
    })
    assert.equal((await later(36, () => call<Ticket>('GET', `/tickets/${old.id}`))).body.archived, false)
    assert.equal((await later(38, () => call<Ticket>('GET', `/tickets/${old.id}`))).body.archived, true)

    await call('PATCH', `/boards/${boardId}`, { archiveDoneDays: null })
    assert.equal((await later(38, () => call<Ticket>('GET', `/tickets/${old.id}`))).body.archived, false)
  })

  test('rejects invalid archive ages', async () => {
    for (const archiveDoneDays of [0, 1.5, -1, '7']) {
      assert.equal((await call('PATCH', `/boards/${boardId}`, { archiveDoneDays })).status, 400)
    }
  })
})

describe('run records', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    agent: 'claude/opus/high',
    outcome: 'finished',
    exitCode: 0,
    durationMs: 1_380_000,
    turns: 41,
    tokens: 1_234_567,
    costUsd: 1.2,
    message: 'Opened the pull request.',
    steps: [
      { tool: 'Bash', summary: 'npm test' },
      { tool: 'Edit', summary: 'src/app.ts', error: true },
    ],
    ...overrides,
  })

  test('records each run on the ticket and lists them newest first', async () => {
    const ticket = await addTicket({ title: 'A' })
    const first = await call<RunRecord>('POST', `/tickets/${ticket.id}/runs`, run())
    const second = await call<RunRecord>('POST', `/tickets/${ticket.id}/runs`, {
      agent: 'claude/opus/high',
      outcome: 'timed_out',
      exitCode: 124,
    })
    const { body: runs } = await call<RunRecord[]>('GET', `/tickets/${ticket.id}/runs`)

    assert.equal(first.status, 201)
    assert.deepEqual(first.body.steps, [
      { tool: 'Bash', summary: 'npm test', error: false },
      { tool: 'Edit', summary: 'src/app.ts', error: true },
    ])
    assert.equal(first.body.omittedSteps, null)
    assert.equal(first.body.tokens, 1_234_567)
    // A run that ended without a result has little more to say.
    assert.deepEqual(
      { ...second.body, id: 0, createdAt: '' },
      {
        id: 0,
        ticketId: ticket.id,
        agent: 'claude/opus/high',
        outcome: 'timed_out',
        exitCode: 124,
        durationMs: null,
        turns: null,
        tokens: null,
        costUsd: null,
        apiKey: false,
        message: '',
        steps: [],
        omittedSteps: null,
        createdAt: '',
      },
    )
    assert.deepEqual(
      runs.map((entry) => entry.outcome),
      ['timed_out', 'finished'],
    )
    assert.equal((await call<RunRecord[]>('GET', `/tickets/${ticket.id}/runs?limit=1`)).body.length, 1)
  })

  test('keeps records small: clips the message and keeps only the newest runs', async () => {
    const ticket = await addTicket({ title: 'A' })
    const long = await call<RunRecord>('POST', `/tickets/${ticket.id}/runs`, run({ message: 'x'.repeat(5000) }))
    for (let i = 0; i < RUN_RECORDS_KEPT; i++) {
      await call('POST', `/tickets/${ticket.id}/runs`, run({ turns: i }))
    }
    const { body: runs } = await call<RunRecord[]>('GET', `/tickets/${ticket.id}/runs?limit=${RUN_RECORDS_KEPT}`)

    assert.equal(long.body.message.length, RUN_MESSAGE_MAX)
    assert.equal(long.body.message.at(-1), '…')
    assert.equal(runs.length, RUN_RECORDS_KEPT)
    assert.ok(runs.every((entry) => entry.id !== long.body.id))
  })

  test('validates runs', async () => {
    const ticket = await addTicket({ title: 'A' })
    const tooMany = Array.from({ length: RUN_MAX_STEPS + 1 }, () => ({ tool: 'Read', summary: 'a.ts' }))
    const omitted = await call<RunRecord>(
      'POST',
      `/tickets/${ticket.id}/runs`,
      run({ omittedSteps: { after: 1, count: 300 } }),
    )

    assert.deepEqual(omitted.body.omittedSteps, { after: 1, count: 300 })
    assert.equal((await call('POST', `/tickets/${ticket.id}/runs`, run({ outcome: 'exploded' }))).status, 400)
    assert.equal((await call('POST', `/tickets/${ticket.id}/runs`, run({ steps: tooMany }))).status, 400)
    assert.equal(
      (await call('POST', `/tickets/${ticket.id}/runs`, run({ omittedSteps: { after: 5, count: 1 } }))).status,
      400,
    )
    assert.equal((await call('POST', '/tickets/nope/runs', run())).status, 404)
    assert.equal((await call('GET', `/tickets/${ticket.id}/runs?limit=0`)).status, 400)
  })
})
