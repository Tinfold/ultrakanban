import assert from 'node:assert/strict'
import { beforeEach, describe, mock, test } from 'node:test'
import {
  type Activity,
  AGENT_IDLE_MINUTES,
  type ApiErrorBody,
  type BoardDetail,
  type BoardSummary,
  type Ticket,
} from '../shared/domain.ts'
import { addTicket, boardId, call, useBoard } from './test-app.ts'

describe('plans and approval', () => {
  const AGENT = 'claude/opus/high'
  const PR = 'https://github.com/acme/app/pull/9'

  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Plans',
      columns: ['Backlog', 'Todo', 'In progress', 'Review', 'Done'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
      approvalSize: 'M',
    })
    useBoard(body.id)
  })

  const claimed = async (title = 'Work') => {
    const ticket = await addTicket({ title, column: 'Todo' })
    return (await call<Ticket>('POST', `/tickets/${ticket.id}/claim`, { agent: AGENT, moveTo: 'In progress' }, AGENT))
      .body
  }
  const plan = (ticket: Ticket, estimate: string, body = `Change things (${estimate})`) =>
    call<Ticket | ApiErrorBody>('POST', `/tickets/${ticket.id}/plan`, { agent: AGENT, estimate, plan: body }, AGENT)
  const approve = (ticket: Ticket, actor = 'person') =>
    call<Ticket | ApiErrorBody>('POST', `/tickets/${ticket.id}/approve`, undefined, actor)
  const getTicket = async (ticket: Ticket) => (await call<Ticket>('GET', `/tickets/${ticket.id}`)).body
  const activity = async (ticket: Ticket) => (await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)).body
  const errorCode = (response: { body: unknown }) => (response.body as ApiErrorBody).error.code

  test('the board setting is saved and can be switched off', async () => {
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    assert.equal(board.board.approvalSize, 'M')
    const { body: off } = await call<BoardSummary>('PATCH', `/boards/${boardId}`, { approvalSize: null })
    assert.equal(off.approvalSize, null)
    const invalid = await call('PATCH', `/boards/${boardId}`, { approvalSize: 'XL' })
    assert.equal(invalid.status, 400)
  })

  test('a plan below the board size sets the estimate without holding the ticket', async () => {
    const ticket = await claimed()
    const response = await plan(ticket, 'S')
    assert.equal(response.status, 200)
    const planned = response.body as Ticket
    assert.equal(planned.estimate, 'S')
    assert.equal(planned.approval, null)
    // The plan isn't a comment: the agent goes on working, so it isn't waiting on anyone.
    assert.equal(planned.waitingSince, null)
    assert.equal(planned.commentCount, 0)

    const entry = (await activity(ticket)).at(-1)!
    assert.equal(entry.type, 'plan')
    assert.equal(entry.actor, AGENT)
    assert.deepEqual(entry.data, { body: 'Change things (S)', estimate: 'S', held: false })
  })

  test('a plan at or above the board size holds the ticket until a person approves it', async () => {
    const ticket = await claimed()
    const held = (await plan(ticket, 'L')).body as Ticket
    assert.equal(held.estimate, 'L')
    assert.equal(held.approval, 'pending')
    assert.ok(held.waitingSince, 'the agent waits on a person')
    assert.deepEqual((await activity(ticket)).at(-1)!.data, { body: 'Change things (L)', estimate: 'L', held: true })

    // It can't be submitted for review meanwhile.
    const submit = await call('POST', `/tickets/${ticket.id}/review`, { agent: AGENT, pullRequest: PR }, AGENT)
    assert.equal(submit.status, 409)
    assert.equal(errorCode(submit), 'awaiting_approval')

    // Its agent can't approve its own plan.
    const own = await approve(ticket, AGENT)
    assert.equal(own.status, 409)
    assert.equal(errorCode(own), 'own_plan')

    const approved = await approve(ticket)
    assert.equal(approved.status, 200)
    assert.equal((approved.body as Ticket).approval, 'approved')
    assert.equal((approved.body as Ticket).waitingSince, null)
    const entry = (await activity(ticket)).at(-1)!
    assert.equal(entry.type, 'approved')
    assert.equal(entry.actor, 'person')
    assert.deepEqual(entry.data, { estimate: 'L' })

    const again = await approve(ticket)
    assert.equal(again.status, 409)
    assert.equal(errorCode(again), 'not_awaiting_approval')

    // A revised plan doesn't need approving again.
    assert.equal(((await plan(ticket, 'L', 'Bigger')).body as Ticket).approval, 'approved')
    assert.equal(
      (await call('POST', `/tickets/${ticket.id}/review`, { agent: AGENT, pullRequest: PR }, AGENT)).status,
      200,
    )
  })

  test('approving checks the version when given one', async () => {
    const ticket = await claimed()
    const held = (await plan(ticket, 'M')).body as Ticket
    const stale = await call('POST', `/tickets/${ticket.id}/approve`, { ifVersion: held.version - 1 })
    assert.equal(stale.status, 409)
    assert.equal(errorCode(stale), 'version_conflict')
    const fresh = await call<Ticket>('POST', `/tickets/${ticket.id}/approve`, { ifVersion: held.version })
    assert.equal(fresh.body.approval, 'approved')
  })

  test('a revised plan below the board size no longer waits', async () => {
    const ticket = await claimed()
    await plan(ticket, 'L')
    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Just fix the one bug' }, 'person')
    assert.equal((await getTicket(ticket)).waitingSince, null, 'the agent has a comment to answer')
    const revised = (await plan(ticket, 'S')).body as Ticket
    assert.equal(revised.estimate, 'S')
    assert.equal(revised.approval, null)
  })

  test('the board holds nothing when the setting is off', async () => {
    await call('PATCH', `/boards/${boardId}`, { approvalSize: null })
    const ticket = await claimed()
    assert.equal(((await plan(ticket, 'L')).body as Ticket).approval, null)
    const response = await approve(ticket)
    assert.equal(response.status, 409)
    assert.equal(errorCode(response), 'not_awaiting_approval')
  })

  test('only the ticket holder posts plans', async () => {
    const ticket = await claimed()
    const response = await call('POST', `/tickets/${ticket.id}/plan`, { agent: 'other', estimate: 'S', plan: 'x' })
    assert.equal(response.status, 409)
    assert.equal(errorCode(response), 'claimed_by_other')
    const invalid = await call('POST', `/tickets/${ticket.id}/plan`, { agent: AGENT, estimate: 'XL', plan: 'x' })
    assert.equal(invalid.status, 400)
  })

  test('a held ticket stops waiting when it is released', async () => {
    const ticket = await claimed()
    await plan(ticket, 'L')
    const released = await call<Ticket>('POST', `/tickets/${ticket.id}/release`, { agent: AGENT, moveTo: 'Backlog' })
    assert.equal(released.body.approval, null)
    assert.equal(released.body.estimate, 'L')
  })

  test('a held ticket is not idle', async () => {
    const held = await claimed('Held')
    await plan(held, 'L')
    const idle = await claimed('Idle')
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    const column = board.columns.find((column) => column.name === 'In progress')!

    mock.timers.enable({ apis: ['Date'], now: Date.now() + (AGENT_IDLE_MINUTES + 1) * 60_000 })
    try {
      const { body: listed } = await call<Ticket[]>('GET', `/columns/${column.id}/idle-tickets`)
      assert.deepEqual(
        listed.map((ticket) => ticket.id),
        [idle.id],
      )
    } finally {
      mock.timers.reset()
    }
  })
})
