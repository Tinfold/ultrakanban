import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { AGENT_EFFORTS, type Ticket } from '../shared/domain.ts'
import type { JevAnswer } from './jev.ts'
import { DESCRIPTION_LIMIT, routeTicket, routingState, type TicketRoute } from './jev-routing.ts'
import { addTicket, boardId, call, jev } from './test-app.ts'

describe('routing a ticket with Jev', () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'ts_key'
    jev.calls.length = 0
    Object.assign(jev, { status: 200, hang: false, answers: [] })
    mock.method(console, 'warn', () => {})
  })
  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY
    mock.restoreAll()
  })

  const getTicket = async (id: string) => (await call<Ticket>('GET', `/tickets/${id}`)).body

  /** Jev's answers: `model` and `effort` picks with their probabilities, and how fully specified the ticket is. */
  function answers(
    model: Record<string, number>,
    effort: Record<string, number>,
    fullySpecified = 0.2,
    confidence = { model: 0.8, effort: 0.7 },
  ): JevAnswer[] {
    const top = (probabilities: Record<string, number>) =>
      Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
    return [
      { id: 'model', type: 'choice', choice: top(model), probabilities: model, confidence: confidence.model },
      {
        id: 'effort',
        type: 'score',
        score: top(effort),
        probabilities: effort,
        confidence: confidence.effort,
        legend: null,
      },
      { id: 'fully_specified', type: 'noul', probability: fullySpecified },
    ]
  }

  test('sends the ticket, its board history and the routing questions', async () => {
    const past = await addTicket({ title: 'Fix login redirect', column: 'Done', tags: ['bug'], force: true })
    await call('POST', `/tickets/${past.id}/usage`, {
      agent: 'claude/sonnet/medium',
      inputTokens: 1000,
      outputTokens: 0,
    })
    await call('POST', `/boards/${boardId}/epics`, { title: 'Login' })
    const created = await addTicket({
      title: 'Fix login timeout',
      description: `${'x'.repeat(DESCRIPTION_LIMIT + 100)}\n- [ ] one\n- [ ] two`,
      tags: ['bug'],
      epic: 'Login',
    })
    await call('POST', `/tickets/${created.id}/plan`, { agent: 'claude/opus/medium', estimate: 'S', plan: 'Do it' })
    const ticket = await getTicket(created.id)

    jev.answers = answers({ haiku: 0.1, sonnet: 0.7, opus: 0.2 }, { low: 0.2, medium: 0.6, high: 0.2 })
    await routeTicket(ticket, { models: ['haiku', 'sonnet', 'opus'] })
    const { state, questions } = jev.calls[0].body
    assert.equal(state.title, 'Fix login timeout')
    assert.equal(state.description, `${'x'.repeat(DESCRIPTION_LIMIT)}\n[cut]`)
    assert.deepEqual(state.tags, ['bug'])
    assert.equal(state.epic, 'Login')
    assert.equal(state.checklistSteps, 2)
    assert.equal(state.planEstimate, 'S')
    assert.deepEqual(state.similarPastTickets, [
      {
        title: 'Fix login redirect',
        similarity: state.similarPastTickets[0].similarity,
        model: 'sonnet',
        effort: 'medium',
        finished: true,
      },
    ])
    assert.deepEqual(
      questions.map((question: { id: string; type: string }) => `${question.id}:${question.type}`),
      ['model:choice', 'effort:score', 'fully_specified:noul'],
    )
    assert.deepEqual(
      questions[0].options.map((option: { name: string }) => option.name),
      ['haiku', 'sonnet', 'opus'],
    )
    assert.ok(questions[0].options.every((option: { description?: string }) => option.description))
    assert.deepEqual(
      questions[1].levels.map((level: { name: string }) => level.name),
      [...AGENT_EFFORTS],
    )
  })

  test('leaves out what the ticket does not have', async () => {
    const ticket = await addTicket({ title: 'Bump version' })
    const state = routingState(ticket)
    assert.equal(state.epic, null)
    assert.equal('planEstimate' in state, false)
    assert.deepEqual(state.tags, [])
    assert.deepEqual(state.similarPastTickets, [])
  })

  test('returns the pick with its confidence and probabilities', async () => {
    const ticket = await addTicket({ title: 'Redesign settings' })
    jev.answers = answers({ haiku: 0.05, sonnet: 0.25, opus: 0.7 }, { low: 0.1, medium: 0.3, high: 0.6 })
    assert.deepEqual(await routeTicket(ticket), {
      model: 'opus',
      effort: 'high',
      confidence: 0.7,
      probabilities: {
        model: { haiku: 0.05, sonnet: 0.25, opus: 0.7 },
        effort: { low: 0.1, medium: 0.3, high: 0.6 },
        fullySpecified: 0.2,
      },
    })
  })

  test('a fully specified ticket tips a near tie to the lower effort', async () => {
    const ticket = await addTicket({ title: 'Rename a field' })
    const effort = { low: 0.42, medium: 0.48, high: 0.1 }
    jev.answers = answers({ sonnet: 1 }, effort, 0.9)
    assert.equal((await routeTicket(ticket))?.effort, 'low')
    jev.answers = answers({ sonnet: 1 }, effort, 0.3)
    assert.equal((await routeTicket(ticket))?.effort, 'medium')
    jev.answers = answers({ sonnet: 1 }, { low: 0.2, medium: 0.7, high: 0.1 }, 0.9)
    assert.equal((await routeTicket(ticket))?.effort, 'medium')
  })

  test('takes the higher effort when the probability is spread over two', async () => {
    const ticket = await addTicket({ title: 'Untangle the merge queue' })
    jev.answers = answers({ opus: 1 }, { medium: 0.45, high: 0.4, xhigh: 0.15 })
    assert.equal((await routeTicket(ticket))?.effort, 'high')
    // The two needn't be next to each other, nor the higher one Jev's own pick.
    jev.answers = answers({ opus: 1 }, { low: 0.38, medium: 0.12, high: 0.4, max: 0.1 })
    assert.equal((await routeTicket(ticket))?.effort, 'high')
    jev.answers = answers({ opus: 1 }, { low: 0.4, high: 0.38, max: 0.22 })
    assert.equal((await routeTicket(ticket))?.effort, 'high')
    // Not spread: Jev's pick stands.
    jev.answers = answers({ opus: 1 }, { medium: 0.55, high: 0.35, xhigh: 0.1 })
    assert.equal((await routeTicket(ticket))?.effort, 'medium')
  })

  test('returns null when Jev fails or its answers do not fit', async () => {
    const ticket = await addTicket({ title: 'Anything' })
    jev.status = 500
    assert.equal(await routeTicket(ticket), null)
    jev.status = 200
    // A model the board doesn't let Jev pick.
    jev.answers = answers({ fable: 0.9, opus: 0.1 }, { medium: 1 })
    assert.equal(await routeTicket(ticket, { models: ['sonnet', 'opus'] }), null)
    jev.answers = answers({ opus: 1 }, { huge: 1 })
    assert.equal(await routeTicket(ticket), null)
    jev.answers = answers({ opus: 1 }, { medium: 1 }).slice(0, 1)
    assert.equal(await routeTicket(ticket), null)
    jev.calls.length = 0
    assert.equal(await routeTicket(ticket, { models: [] }), null)
    assert.equal(jev.calls.length, 0)
  })

  test('suggests a setting on demand for a draft, recording nothing', async () => {
    await call('POST', `/boards/${boardId}/epics`, { title: 'Login' })
    jev.answers = answers({ haiku: 0.1, sonnet: 0.7, opus: 0.2 }, { low: 0.2, medium: 0.6, high: 0.2 })
    const { status, body } = await call<TicketRoute>('POST', `/boards/${boardId}/jev-suggestion`, {
      title: 'Fix login timeout',
      description: '- [ ] one',
      tagIds: ['no-such-tag'],
    })
    assert.equal(status, 200)
    assert.equal(body.model, 'sonnet')
    assert.equal(body.effort, 'medium')
    assert.deepEqual(body.probabilities.model, { haiku: 0.1, sonnet: 0.7, opus: 0.2 })
    assert.equal(jev.calls[0].body.state.title, 'Fix login timeout')
    assert.deepEqual(jev.calls[0].body.state.tags, [])
  })

  test('the on-demand suggestion needs a key and an answer from Jev', async () => {
    jev.status = 500
    assert.equal((await call('POST', `/boards/${boardId}/jev-suggestion`, { title: 'Anything' })).status, 502)
    delete process.env.TYPESAFE_API_KEY
    const { status, body } = await call<{ error: { code: string } }>('POST', `/boards/${boardId}/jev-suggestion`, {})
    assert.equal(status, 409)
    assert.equal(body.error.code, 'jev_unavailable')
  })
})
