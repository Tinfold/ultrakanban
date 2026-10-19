import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import {
  type AgentSuggestion,
  type AgentEffort,
  JEV_AGENT,
  type Overview,
  type RoutedSetting,
  type RoutingComparison,
  type Ticket,
  type TokenUsage,
} from '../shared/domain.ts'
import { JEV_MODEL, type JevAnswer } from './jev.ts'
import { addTicket, boardId, call, jev, useBoard } from './test-app.ts'

/** Jev's answers picking `model` at `effort` with `confidence`. */
const picks = (model: string, effort: AgentEffort, confidence = 0.9): JevAnswer[] => [
  { id: 'model', type: 'choice', choice: model, probabilities: { [model]: 1 }, confidence },
  { id: 'effort', type: 'score', score: effort, probabilities: { [effort]: 1 }, confidence, legend: null },
  { id: 'fully_specified', type: 'noul', probability: 0.2 },
]

describe('routing', () => {
  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Routing',
      columns: ['Todo', 'In progress', 'Review', 'Done', 'Cancelled'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
    })
    useBoard(body.id)
    process.env.TYPESAFE_API_KEY = 'ts_key'
    jev.calls.length = 0
    Object.assign(jev, { status: 200, hang: false, answers: picks('haiku', 'low') })
    mock.method(console, 'warn', () => {})
  })
  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY
    mock.restoreAll()
  })

  const routeWithJev = (body: Record<string, unknown> = {}) =>
    call('PATCH', `/boards/${boardId}`, { jevEnabled: true, ...body })
  const claim = async (ticket: Ticket, agent = 'claude/opus/medium') =>
    (await call<Ticket>('POST', `/tickets/${ticket.id}/claim`, { agent, moveTo: 'In progress' })).body
  const run = async (ticket: Ticket, agent: string, costUsd: number | null = 1, tokens = {}) =>
    (
      await call<TokenUsage>('POST', `/tickets/${ticket.id}/usage`, {
        agent,
        inputTokens: 1000,
        outputTokens: 0,
        costUsd,
        ...tokens,
      })
    ).body
  const decide = (ticket: Ticket, column: 'Done' | 'Cancelled') =>
    call('POST', `/tickets/${ticket.id}/move`, { column, force: true })
  const usage = async (ticket: Ticket) => (await call<TokenUsage[]>('GET', `/tickets/${ticket.id}/usage`)).body
  const comparison = async () =>
    (await call<AgentSuggestion>('GET', `/boards/${boardId}/agent-suggestion?title=Anything`)).body.routing

  /** A ticket claimed (Jev answering `jevPick`), worked at `agent` for `costUsd` and ended in `column`. */
  async function routed(
    title: string,
    agent: string,
    column: 'Done' | 'Cancelled',
    { costUsd = 1, jevPick = picks('haiku', 'low'), input = {} as Record<string, unknown> } = {},
  ) {
    const ticket = await addTicket({ title, ...input })
    jev.answers = jevPick
    await claim(ticket, agent)
    await run(ticket, agent, costUsd)
    await decide(ticket, column)
    return ticket
  }

  test('records the source of each run: the default, or the ticket’s own setting', async () => {
    const plain = await addTicket({ title: 'Plain' })
    await claim(plain)
    assert.deepEqual((await run(plain, 'claude/opus/medium')).routing, {
      source: 'default',
      confidence: null,
      jev: null,
    })

    const own = await addTicket({ title: 'Own', agentModel: 'sonnet', agentEffort: 'low' })
    await claim(own, 'claude/sonnet/low')
    assert.equal((await run(own, 'claude/sonnet/low')).routing?.source, 'ticket')
    // A ticket that names only its model is worked at the board's effort.
    const model = await addTicket({ title: 'Model only', agentModel: 'haiku' })
    await claim(model, 'claude/haiku/medium')
    assert.equal((await run(model, 'claude/haiku/medium')).routing?.source, 'ticket')

    // Neither its own setting nor the default, another agent's run, or a run on no ticket: no source.
    assert.equal((await run(plain, 'claude/fable/max')).routing, null)
    assert.equal((await run(plain, 'codex/opus/medium')).routing, null)
    const board = await call<TokenUsage>('POST', `/boards/${boardId}/usage`, {
      agent: 'claude/opus/medium',
      inputTokens: 10,
      outputTokens: 0,
    })
    assert.equal(board.body.routing, null)
  })

  test('works out the source of tickets claimed before routing was recorded', async () => {
    const ticket = await addTicket({ title: 'Assigned by hand', agentEffort: 'high' })
    await call('PATCH', `/tickets/${ticket.id}`, { assignee: 'claude/opus/high' })
    assert.equal((await run(ticket, 'claude/opus/high')).routing?.source, 'ticket')
    assert.equal((await run(ticket, 'claude/opus/medium')).routing?.source, 'default')
  })

  test('dry run: asks Jev at claim time and records its pick on the runs without using it', async () => {
    await routeWithJev()
    const ticket = await addTicket({ title: 'Fix a typo in the README' })
    jev.answers = picks('haiku', 'low', 0.85)
    const claimed = await claim(ticket)
    assert.equal(jev.calls.length, 1)
    assert.equal(jev.calls[0].body.state.title, 'Fix a typo in the README')
    assert.equal(claimed.agentModel, null)
    assert.equal(claimed.agentEffort, null)

    const used = await run(ticket, 'claude/opus/medium')
    assert.deepEqual(used.routing, {
      source: 'default',
      confidence: null,
      jev: { model: 'haiku', effort: 'low', confidence: 0.85 },
    })
  })

  test('counts Jev’s own tokens and cost in the ticket’s usage', async () => {
    await routeWithJev()
    const ticket = await addTicket({ title: 'Anything' })
    await claim(ticket)
    const [call] = await usage(ticket)
    assert.equal(call.agent, JEV_AGENT)
    assert.equal(call.inputTokens, 1200)
    assert.equal(call.routing, null)
    assert.ok(Math.abs(call.costUsd! - 1200 * 0.042e-6) < 1e-12)
    assert.deepEqual(
      call.models.map(({ model, inputTokens }) => ({ model, inputTokens })),
      [{ model: JEV_MODEL, inputTokens: 1200 }],
    )
  })

  test('a failing Jev doesn’t fail the claim, and boards without Jev never ask it', async () => {
    await routeWithJev()
    jev.status = 500
    const failed = await addTicket({ title: 'Jev down' })
    assert.equal((await claim(failed)).assignee, 'claude/opus/medium')
    assert.equal((await run(failed, 'claude/opus/medium')).routing?.jev, null)
    assert.deepEqual(
      (await usage(failed)).map((entry) => entry.agent),
      ['claude/opus/medium'],
    )

    jev.calls.length = 0
    await call('PATCH', `/boards/${boardId}`, { jevEnabled: false })
    const plain = await addTicket({ title: 'No Jev' })
    await claim(plain)
    assert.equal(jev.calls.length, 0)
    const next = await addTicket({ title: 'Claimed next' })
    await call('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'claude/opus/medium', column: 'Todo' })
    assert.equal(jev.calls.length, 0)
    assert.equal((await run(next, 'claude/opus/medium')).routing?.source, 'default')
  })

  test('claim-next asks Jev too', async () => {
    await routeWithJev()
    const ticket = await addTicket({ title: 'Next one' })
    await call('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'claude/opus/medium', column: 'Todo' })
    assert.equal(jev.calls.length, 1)
    assert.equal((await run(ticket, 'claude/opus/medium')).routing?.jev?.model, 'haiku')
  })

  test('compares cost per finished ticket of Jev’s picks and the default', async () => {
    await routeWithJev()
    // Tickets that name haiku/low themselves: two of three finished, $0.10 each.
    for (const [index, column] of (['Done', 'Done', 'Cancelled'] as const).entries()) {
      await routed(`Rename ${index}`, 'claude/haiku/low', column, {
        costUsd: 0.1,
        input: { agentModel: 'haiku', agentEffort: 'low' },
      })
    }
    // Tickets worked at the default, opus/medium: all finished, $1 each. Jev would have picked haiku/low.
    for (const index of [0, 1, 2]) await routed(`Feature ${index}`, 'claude/opus/medium', 'Done')
    // Still being worked: tells nothing yet.
    const open = await addTicket({ title: 'Open' })
    await claim(open)
    await run(open, 'claude/opus/medium')
    await call('POST', `/tickets/${(await addTicket({ title: 'Not claimed' })).id}/move`, { column: 'Done' })

    const routing = await comparison()
    assert.equal(routing.unit, 'usd')
    assert.equal(routing.verdict, null)
    assert.equal(routing.jev.calls, 7)
    // Jev counts haiku/low tickets as they went and the others at haiku/low's average: 2/3 finished, $0.10 each.
    const [jevStats, defaultStats] = routing.sources
    assert.deepEqual(jevStats, {
      source: 'jev',
      tickets: 6,
      picked: 6,
      worked: 3,
      unmeasured: 0,
      finished: 4,
      successRate: 0.667,
      costUsd: 0.6,
      weightedTokens: 6000,
      costPerFinished: 0.15,
    })
    // The default counts its own tickets as they went and the haiku/low ones at opus/medium's average: $1 each.
    assert.equal(defaultStats.source, 'default')
    assert.equal(defaultStats.worked, 3)
    assert.equal(defaultStats.finished, 6)
    assert.equal(defaultStats.costPerFinished, 1)
  })

  test('falls back below the board’s threshold, and leaves out picks the board has too few tickets at', async () => {
    await routeWithJev({ jevThreshold: 0.95 })
    for (const index of [0, 1, 2]) await routed(`Feature ${index}`, 'claude/opus/medium', 'Done')
    let routing = await comparison()
    // Below the threshold Jev picked nothing for itself, so it is the default and isn't compared.
    assert.deepEqual(
      routing.sources.map((source) => source.source),
      ['default'],
    )

    await call('PATCH', `/boards/${boardId}`, { jevThreshold: 0.5 })
    routing = await comparison()
    const jevStats = routing.sources.find((source) => source.source === 'jev')!
    // Nothing was ever worked at haiku/low, so none of Jev's picks can be counted.
    assert.equal(jevStats.unmeasured, 3)
    assert.equal(jevStats.tickets, 0)
    assert.equal(jevStats.costPerFinished, null)
  })

  test('weighs tokens by kind when runs report no cost', async () => {
    const ticket = await addTicket({ title: 'Local model' })
    await claim(ticket)
    await run(ticket, 'claude/opus/medium', null, {
      outputTokens: 100,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 800,
    })
    await decide(ticket, 'Done')
    const routing = await comparison()
    assert.equal(routing.unit, 'tokens')
    // 1000 input + 100 output × 5 + 100,000 cache reads × 0.1 + 800 cache writes × 1.25.
    assert.deepEqual(
      routing.sources.map(({ source, costUsd, weightedTokens, costPerFinished }) => ({
        source,
        costUsd,
        weightedTokens,
        costPerFinished,
      })),
      [{ source: 'default', costUsd: null, weightedTokens: 12_500, costPerFinished: 12_500 }],
    )
  })

  test('names the cheapest source once each has enough finished tickets, in the overview too', async () => {
    await routeWithJev()
    for (let index = 0; index < 12; index++) {
      await routed(`Rename ${index}`, 'claude/haiku/low', index % 3 === 2 ? 'Cancelled' : 'Done', {
        costUsd: 0.1,
        input: { agentModel: 'haiku', agentEffort: 'low' },
      })
      await routed(`Feature ${index}`, 'claude/opus/medium', 'Done')
    }
    const routing = await comparison()
    assert.equal(routing.verdict, 'jev')
    // History picks too, once similar tickets are decided, but costs more per finished ticket than Jev.
    const finished = Object.fromEntries(routing.sources.map((source) => [source.source, source.finished]))
    assert.equal(routing.sources[0].source, 'jev')
    assert.equal(finished.jev, 16)
    assert.equal(finished.default, 24)

    const overview = (await call<Overview>('GET', '/overview?days=7')).body
    const jevOverview = overview.routing.sources.find((source) => source.source === 'jev')
    assert.ok(jevOverview && jevOverview.tickets >= 24)
    assert.ok(overview.routing.jev.calls >= 24)
  })

  test('records the history suggestion’s pick when it is built on enough similar tickets', async () => {
    for (const index of [0, 1, 2]) {
      await routed(`Fix login bug ${index}`, 'claude/sonnet/low', 'Done', {
        costUsd: 0.2,
        input: { agentModel: 'sonnet', agentEffort: 'low', tags: ['bug'] },
      })
    }
    const ticket = await addTicket({ title: 'Fix login bug again', tags: ['bug'] })
    await claim(ticket)
    await run(ticket, 'claude/opus/medium', 1)
    await decide(ticket, 'Done')
    const routing: RoutingComparison = await comparison()
    const history = routing.sources.find((source) => source.source === 'history')!
    // History had too few similar tickets for the first three, so it fell back to the default, which the board has
    // too few tickets at to count them. It picked sonnet/low for the last one, counted at sonnet/low's average.
    assert.deepEqual(
      { picked: history.picked, tickets: history.tickets, unmeasured: history.unmeasured, costUsd: history.costUsd },
      { picked: 1, tickets: 1, unmeasured: 3, costUsd: 0.2 },
    )
  })

  describe('when Jev’s picks are used', () => {
    type Claimed = Ticket & { routed?: RoutedSetting }
    const routeOn = (body: Record<string, unknown> = {}) => routeWithJev({ jevMode: 'on', ...body })
    const claimed = async (ticket: Ticket) =>
      (
        await call<Claimed>('POST', `/tickets/${ticket.id}/claim`, {
          agent: 'claude/opus/medium',
          moveTo: 'In progress',
        })
      ).body
    const route = async (ticket: Ticket) =>
      (await call<{ routed: RoutedSetting | null }>('GET', `/tickets/${ticket.id}/route`)).body.routed
    /** Three finished tickets worked at sonnet/low, so the history suggestion picks it for tickets like them. */
    async function history() {
      for (const index of [0, 1, 2]) {
        await routed(`Fix login bug ${index}`, 'claude/sonnet/low', 'Done', {
          input: { agentModel: 'sonnet', agentEffort: 'low', tags: ['bug'] },
        })
      }
      jev.calls.length = 0
    }

    test('returns Jev’s pick as routed, leaving the ticket’s own fields alone, and records it on the runs', async () => {
      await routeOn()
      const ticket = await addTicket({ title: 'Fix a typo in the README' })
      jev.answers = picks('haiku', 'low', 0.85)
      const body = await claimed(ticket)
      assert.deepEqual(body.routed, { model: 'haiku', effort: 'low', source: 'jev', confidence: 0.85 })
      assert.equal(body.agentModel, null)
      assert.equal(body.agentEffort, null)
      assert.equal((await call<Ticket>('GET', `/tickets/${ticket.id}`)).body.agentModel, null)
      assert.deepEqual((await run(ticket, 'claude/haiku/low')).routing, {
        source: 'jev',
        confidence: 0.85,
        jev: { model: 'haiku', effort: 'low', confidence: 0.85 },
      })

      const next = await addTicket({ title: 'Next one' })
      const { body: fromNext } = await call<Claimed>('POST', `/boards/${boardId}/tickets/claim-next`, {
        agent: 'claude/opus/medium',
        column: 'Todo',
      })
      assert.equal(fromNext.id, next.id)
      assert.equal(fromNext.routed?.source, 'jev')
    })

    test('the ticket’s own setting wins, and Jev isn’t asked for it', async () => {
      await routeOn()
      const own = await addTicket({ title: 'Own', agentModel: 'sonnet' })
      assert.deepEqual((await claimed(own)).routed, {
        model: 'sonnet',
        effort: 'medium',
        source: 'ticket',
        confidence: null,
      })
      assert.equal(jev.calls.length, 0)
    })

    test('below the threshold, falls back to the history suggestion, then the default', async () => {
      await history()
      await routeOn({ jevThreshold: 0.8 })
      jev.answers = picks('haiku', 'low', 0.75)
      const like = await addTicket({ title: 'Fix login bug again', tags: ['bug'] })
      assert.deepEqual((await claimed(like)).routed, {
        model: 'sonnet',
        effort: 'low',
        source: 'history',
        confidence: null,
      })
      assert.equal(jev.calls.length, 1)
      assert.equal((await run(like, 'claude/sonnet/low')).routing?.source, 'history')

      const unlike = await addTicket({ title: 'Write release notes' })
      assert.deepEqual((await claimed(unlike)).routed, {
        model: 'opus',
        effort: 'medium',
        source: 'default',
        confidence: null,
      })
    })

    test('uses Jev’s pick at the threshold, and goes to the next source just below it', async () => {
      await routeOn({ jevThreshold: 0.8 })
      jev.answers = picks('opus', 'high', 0.8)
      assert.equal((await claimed(await addTicket({ title: 'Untangle the merge queue' }))).routed?.source, 'jev')
      jev.answers = picks('opus', 'high', 0.79)
      assert.equal((await claimed(await addTicket({ title: 'Redesign the store' }))).routed?.source, 'default')
    })

    test('dropping to haiku or low needs a higher confidence than staying at the default', async () => {
      await routeOn()
      const source = async (title: string, model: string, effort: AgentEffort, confidence: number) => {
        jev.answers = picks(model, effort, confidence)
        return (await claimed(await addTicket({ title }))).routed?.source
      }
      // The board's default is opus/medium and its threshold 0.7, so haiku or low need 0.85.
      assert.equal(await source('Raise the effort', 'opus', 'high', 0.75), 'jev')
      assert.equal(await source('Lower the model', 'sonnet', 'medium', 0.75), 'jev')
      assert.equal(await source('Drop to haiku', 'haiku', 'medium', 0.8), 'default')
      assert.equal(await source('Drop to low', 'opus', 'low', 0.8), 'default')
      assert.equal(await source('Drop to both', 'haiku', 'low', 0.85), 'jev')

      // Where the default is haiku/low already, staying there isn't a drop.
      await call('PATCH', `/boards/${boardId}`, { agentModel: 'haiku', agentEffort: 'low' })
      assert.equal(await source('Stay at the default', 'haiku', 'low', 0.75), 'jev')
    })

    test('never routes below the setting the ticket’s last run used', async () => {
      await routeOn()
      jev.answers = picks('haiku', 'low')
      const ticket = await addTicket({ title: 'Fix a typo in the README' })
      assert.deepEqual((await claimed(ticket)).routed, {
        model: 'haiku',
        effort: 'low',
        source: 'jev',
        confidence: 0.9,
      })
      // Its run failed, or came back with changes requested, after a run at sonnet/high: the next run keeps it.
      await run(ticket, 'claude/sonnet/high')
      assert.deepEqual(await route(ticket), { model: 'sonnet', effort: 'high', source: 'jev', confidence: 0.9 })
      // Only the newest run counts, and only one of the board's agent; each half is raised on its own.
      await run(ticket, 'claude/opus/low')
      await run(ticket, 'codex/gpt-5-codex/max')
      assert.deepEqual(await route(ticket), { model: 'opus', effort: 'low', source: 'jev', confidence: 0.9 })
      // A dearer pick isn't lowered.
      await call('PATCH', `/tickets/${ticket.id}`, { title: 'Fix the typos in the README' })
      jev.answers = picks('sonnet', 'xhigh')
      assert.deepEqual(await route(ticket), { model: 'opus', effort: 'xhigh', source: 'jev', confidence: 0.9 })

      // The default is raised too, but a ticket's own setting is a person's choice and stays.
      const plain = await addTicket({ title: 'Write release notes' })
      jev.answers = picks('haiku', 'low', 0.1)
      await claimed(plain)
      await run(plain, 'claude/fable/high')
      assert.deepEqual(await route(plain), { model: 'fable', effort: 'high', source: 'default', confidence: null })
      const own = await addTicket({ title: 'Bump the version', agentModel: 'haiku', agentEffort: 'low' })
      await claimed(own)
      await run(own, 'claude/fable/high')
      assert.deepEqual(await route(own), { model: 'haiku', effort: 'low', source: 'ticket', confidence: null })
    })

    test('the history suggestion needs 3 similar tickets', async () => {
      await routed('Fix login bug 0', 'claude/sonnet/low', 'Done', {
        input: { agentModel: 'sonnet', agentEffort: 'low', tags: ['bug'] },
      })
      await routed('Fix login bug 1', 'claude/sonnet/low', 'Done', {
        input: { agentModel: 'sonnet', agentEffort: 'low', tags: ['bug'] },
      })
      await routeOn()
      jev.answers = picks('haiku', 'low', 0.1)
      const ticket = await addTicket({ title: 'Fix login bug again', tags: ['bug'] })
      assert.equal((await claimed(ticket)).routed?.source, 'default')
    })

    test('keeps to the board’s models for Jev', async () => {
      await history()
      await routeOn({ jevModels: ['opus', 'haiku'] })
      // Jev is only offered the board's models; an answer outside them is left out, and so is a history pick.
      jev.answers = picks('sonnet', 'low')
      const ticket = await addTicket({ title: 'Fix login bug again', tags: ['bug'] })
      const body = await claimed(ticket)
      assert.deepEqual(
        jev.calls[0].body.questions[0].options.map((option: { name: string }) => option.name),
        ['opus', 'haiku'],
      )
      assert.equal(body.routed?.source, 'default')
    })

    test('may only lower: holds Jev’s and the history suggestion’s picks to the board’s default', async () => {
      await history()
      await call('PATCH', `/boards/${boardId}`, { agentModel: 'sonnet', agentEffort: 'medium' })
      await routeOn({ jevOnlyLower: true })
      jev.answers = picks('fable', 'low')
      const dearer = await addTicket({ title: 'Redesign the store' })
      assert.deepEqual((await claimed(dearer)).routed, {
        model: 'sonnet',
        effort: 'low',
        source: 'jev',
        confidence: 0.9,
      })
      jev.answers = picks('haiku', 'max')
      const harder = await addTicket({ title: 'Untangle the merge queue' })
      assert.deepEqual((await claimed(harder)).routed, {
        model: 'haiku',
        effort: 'medium',
        source: 'jev',
        confidence: 0.9,
      })

      await call('PATCH', `/boards/${boardId}`, { agentModel: 'haiku', agentEffort: 'medium' })
      jev.answers = picks('fable', 'max', 0.1)
      const like = await addTicket({ title: 'Fix login bug again', tags: ['bug'] })
      assert.deepEqual((await claimed(like)).routed, {
        model: 'haiku',
        effort: 'low',
        source: 'history',
        confidence: null,
      })
    })

    test('keeps Jev’s pick while the ticket doesn’t change, so claims again and feedback runs don’t ask it', async () => {
      await routeOn()
      jev.answers = picks('haiku', 'low', 0.85)
      const ticket = await addTicket({ title: 'Fix a typo', description: '- [ ] fix it\n- [ ] test it' })
      await claimed(ticket)
      assert.equal(jev.calls.length, 1)
      jev.answers = picks('fable', 'max')
      await call('POST', `/tickets/${ticket.id}/checklist/0`, { checked: true })
      await call('PATCH', `/tickets/${ticket.id}`, { assignee: 'claude/haiku/low' })
      assert.deepEqual(await route(ticket), { model: 'haiku', effort: 'low', source: 'jev', confidence: 0.85 })
      await call('POST', `/tickets/${ticket.id}/release`, { agent: 'claude/haiku/low', moveTo: 'Todo' })
      assert.equal((await claimed(ticket)).routed?.model, 'haiku')
      assert.equal(jev.calls.length, 1)
      assert.equal((await usage(ticket)).filter((entry) => entry.agent === JEV_AGENT).length, 1)

      // Edited, it is routed again.
      await call('PATCH', `/tickets/${ticket.id}`, { description: 'Rewrite the parser.' })
      assert.deepEqual(await route(ticket), { model: 'fable', effort: 'max', source: 'jev', confidence: 0.9 })
      assert.equal(jev.calls.length, 2)
      assert.equal((await run(ticket, 'claude/fable/max')).routing?.source, 'jev')
    })

    test('the route is null unless Jev’s picks are used, and asks nothing then', async () => {
      const ticket = await addTicket({ title: 'Anything' })
      assert.equal(await route(ticket), null)
      await routeWithJev()
      assert.equal(await route(ticket), null)
      assert.equal(jev.calls.length, 0)
      assert.equal((await claimed(ticket)).routed, undefined)
      assert.equal(jev.calls.length, 1)
    })

    test('Jev failing or timing out doesn’t fail the claim, which goes to the next source, and isn’t kept', async () => {
      await history()
      await routeOn()
      jev.status = 500
      const like = await addTicket({ title: 'Fix login bug again', tags: ['bug'] })
      const failed = await claimed(like)
      assert.equal(failed.assignee, 'claude/opus/medium')
      assert.equal(failed.routed?.source, 'history')

      jev.status = 200
      jev.hang = true
      const unlike = await addTicket({ title: 'Write release notes' })
      const timedOut = await claimed(unlike)
      assert.equal(timedOut.assignee, 'claude/opus/medium')
      assert.equal(timedOut.routed?.source, 'default')
      assert.equal((await usage(unlike)).length, 0)

      // A failed request isn't kept: the next run asks again.
      jev.hang = false
      jev.answers = picks('haiku', 'low')
      jev.calls.length = 0
      assert.equal((await route(unlike))?.source, 'jev')
      assert.equal(jev.calls.length, 1)
    })
  })
})
