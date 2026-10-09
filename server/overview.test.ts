import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { type Overview, type Ticket, type TokenUsage } from '../shared/domain.ts'
import { getOverview } from './store/overview.ts'
import { addTicket, boardId, call, pullRequestStatuses, useBoard } from './test-app.ts'

describe('overview', () => {
  const PR = 'https://github.com/acme/app/pull/42'

  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Workflow',
      columns: ['Todo', 'In progress', 'Review', 'Done'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
    })
    useBoard(body.id)
  })

  test('overview shows who works on what, for how long, and what got done', async () => {
    const agent = 'overview-agent'
    const ticket = await addTicket({ title: 'A' })
    const other = await addTicket({ title: 'B' })
    await call('POST', `/boards/${boardId}/tickets/claim-next`, { agent, column: 'Todo', moveTo: 'In progress' })

    const { body: working } = await call<Overview>('GET', '/overview?days=7')
    const agentOf = (overview: Overview) => overview.agents.find((entry) => entry.name === agent)!
    const boardOf = (overview: Overview) => overview.boards.find((entry) => entry.id === boardId)!
    assert.equal(working.days, 7)
    assert.equal(agentOf(working).status, 'working')
    assert.deepEqual(
      agentOf(working).tickets.map((held) => [held.id, held.column, held.state]),
      [[ticket.id, 'In progress', 'working']],
    )
    assert.deepEqual([boardOf(working).open, boardOf(working).working, boardOf(working).review], [2, 1, 0])
    assert.equal(working.recent[0].ticket.boardId, boardId)

    // Ongoing work counts up to the time of the overview.
    const hourLater = getOverview(7, new Date(Date.now() + 60 * 60 * 1000))
    assert.ok(Math.abs(agentOf(hourLater).workedMs - 60 * 60 * 1000) < 60 * 1000)

    await call('POST', `/tickets/${ticket.id}/review`, { agent, pullRequest: PR })
    const { body: inReview } = await call<Overview>('GET', '/overview')
    assert.equal(inReview.days, 14)
    assert.equal(agentOf(inReview).status, 'review')
    assert.deepEqual(
      inReview.sessions.filter((session) => session.agent === agent).map((session) => session.end !== null),
      [true],
    )

    pullRequestStatuses.set(PR, { state: 'merged', title: 'Some PR' })
    await call('POST', `/tickets/${ticket.id}/pull-request/sync`)
    pullRequestStatuses.clear()
    const { body: done } = await call<Overview>('GET', '/overview')
    assert.deepEqual([agentOf(done).status, agentOf(done).tickets.length, agentOf(done).completed], ['idle', 0, 1])
    assert.deepEqual([boardOf(done).open, boardOf(done).completed], [1, 1])
    assert.ok(done.events.some((event) => event.boardId === boardId && event.kind === 'completed'))
    const completion = done.completions.find((entry) => entry.ticketId === ticket.id)!
    assert.ok(completion.cycleMs !== null && completion.reviewMs !== null && completion.cycleMs >= completion.reviewMs)

    // Tickets moved to done without being worked or reviewed have no cycle or review time.
    await call('POST', `/tickets/${other.id}/move`, { column: 'Done', force: true })
    const { body: moved } = await call<Overview>('GET', '/overview')
    const skipped = moved.completions.find((entry) => entry.ticketId === other.id)!
    assert.deepEqual([skipped.cycleMs, skipped.reviewMs], [null, null])

    assert.equal((await call('GET', '/overview?days=3')).status, 400)
  })

  test('overview drops tickets whose pull request was closed or that were cancelled', async () => {
    const agent = 'closing-agent'
    await call('POST', `/boards/${boardId}/columns`, { name: 'Cancelled' })
    const closed = await addTicket({ title: 'Closed' })
    const cancelled = await addTicket({ title: 'Cancelled', column: 'In progress' })
    await call('POST', `/tickets/${closed.id}/claim`, { agent, moveTo: 'In progress' })
    await call('POST', `/tickets/${cancelled.id}/claim`, { agent })
    await call('POST', `/tickets/${closed.id}/review`, { agent, pullRequest: PR })
    pullRequestStatuses.set(PR, { state: 'closed', title: 'Some PR' })
    await call('POST', `/tickets/${closed.id}/pull-request/sync`)
    pullRequestStatuses.clear()
    await call('POST', `/tickets/${cancelled.id}/move`, { column: 'Cancelled' })

    const { body: overview } = await call<Overview>('GET', '/overview')
    const held = overview.agents.find((entry) => entry.name === agent)!
    const board = overview.boards.find((entry) => entry.id === boardId)!
    assert.deepEqual([held.status, held.tickets.length], ['idle', 0])
    assert.deepEqual([board.open, board.working, board.review], [0, 0, 0])
    assert.ok(overview.sessions.filter((session) => session.agent === agent).every((session) => session.end !== null))
  })

  test("a ticket waits on you while the newest comment is its agent's, until it goes to review", async () => {
    const agent = 'asking-agent'
    const ticket = await addTicket({ title: 'A' })
    const waitingSince = async () => (await call<Ticket>('GET', `/tickets/${ticket.id}`)).body.waitingSince
    const heldWaitingSince = async () =>
      (await call<Overview>('GET', '/overview')).body.agents.find((entry) => entry.name === agent)!.tickets[0]
        .waitingSince

    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Before anyone works it' }, agent)
    assert.equal(await waitingSince(), null)

    await call('POST', `/tickets/${ticket.id}/claim`, { agent, moveTo: 'In progress' })
    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Should it do X?' }, 'someone-else')
    assert.equal(await waitingSince(), null)

    const { body: question } = await call<{ createdAt: string }>(
      'POST',
      `/tickets/${ticket.id}/comments`,
      { body: 'Should it do X or Y?' },
      agent,
    )
    assert.equal(await waitingSince(), question.createdAt)
    assert.equal(await heldWaitingSince(), question.createdAt)
    // Other activity, such as moving it, doesn't answer the question.
    await call('POST', `/tickets/${ticket.id}/move`, { column: 'Todo' })
    assert.equal(await waitingSince(), question.createdAt)
    await call('POST', `/tickets/${ticket.id}/move`, { column: 'In progress' })

    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Y' }, 'tester')
    assert.equal(await waitingSince(), null)
    assert.equal(await heldWaitingSince(), null)

    // Submitting for review comments too, but a ticket in review waits for its review instead.
    await call('POST', `/tickets/${ticket.id}/review`, { agent, pullRequest: PR, comment: 'Done' })
    assert.equal(await waitingSince(), null)
    assert.equal(await heldWaitingSince(), null)
  })

  test('overview counts parallel runs under one agent name as separate working agents', async () => {
    const agent = 'parallel-agent'
    const before = (await call<Overview>('GET', '/overview')).body.totals.activeAgents
    for (const title of ['A', 'B']) {
      const ticket = await addTicket({ title })
      await call('POST', `/tickets/${ticket.id}/claim`, { agent, moveTo: 'In progress' })
    }
    const { body } = await call<Overview>('GET', '/overview')
    assert.equal(body.totals.activeAgents, before + 2)
    assert.equal(body.agents.filter((entry) => entry.name === agent).length, 1)
  })

  test('overview lists enabled board agents under their worker names', async () => {
    await call('PATCH', `/boards/${boardId}`, { githubRepo: 'acme/app', agentEnabled: true, agentName: 'idle-agent' })
    const { body: idle } = await call<Overview>('GET', '/overview')
    const agent = idle.agents.find((entry) => entry.name === 'idle-agent/opus/medium')
    assert.deepEqual([agent?.status, agent?.agentOf], ['idle', [boardId]])
    assert.ok(!idle.agents.some((entry) => entry.name === 'idle-agent' || entry.name === 'idle-agent/opus/max'))

    // Another board whose agent has the same name shares its worker names.
    const { body: other } = await call<{ id: string }>('POST', '/boards', { name: 'Other', columns: ['Todo', 'Done'] })
    await call('PATCH', `/boards/${other.id}`, {
      githubRepo: 'acme/other',
      agentEnabled: true,
      agentName: 'idle-agent',
    })
    await call('POST', `/boards/${other.id}/tickets`, { title: 'B', agentModel: 'sonnet' })

    // A ticket's own model and effort run under their own worker name, which still counts as the board's host agent,
    // but only of the boards it works on.
    await addTicket({ title: 'A', agentModel: 'sonnet' })
    await call('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'idle-agent/sonnet/max', column: 'Todo' })
    const { body: working } = await call<Overview>('GET', '/overview')
    const variant = working.agents.find((entry) => entry.name === 'idle-agent/sonnet/max')
    assert.deepEqual([variant?.status, variant?.agentOf], ['working', [boardId]])
    const worker = working.agents.find((entry) => entry.name === 'idle-agent/opus/medium')
    assert.deepEqual(worker?.agentOf.sort(), [boardId, other.id].sort())
    for (const id of [boardId, other.id]) await call('PATCH', `/boards/${id}`, { agentEnabled: false })
  })

  test('agents report the tokens their runs use, and the overview adds them up', async () => {
    const agent = 'token-agent'
    const ticket = await addTicket({ title: 'A' })
    const run = { agent, inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400 }
    const { status, body: recorded } = await call<TokenUsage>('POST', `/tickets/${ticket.id}/usage`, {
      ...run,
      costUsd: 0.25,
      durationMs: 60_000,
    })
    assert.equal(status, 201)
    assert.deepEqual([recorded.ticketId, recorded.costUsd, recorded.durationMs], [ticket.id, 0.25, 60_000])
    // Cache counts, cost and duration are optional.
    await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: 1, outputTokens: 2 })
    assert.equal(
      (await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: -1, outputTokens: 0 })).status,
      400,
    )
    assert.equal((await call('POST', '/tickets/nope/usage', run)).status, 404)

    const { body: listed } = await call<TokenUsage[]>('GET', `/tickets/${ticket.id}/usage`)
    assert.deepEqual(
      listed.map((entry) => [entry.inputTokens, entry.cacheReadTokens, entry.costUsd]),
      [
        [10, 3000, 0.25],
        [1, 0, null],
      ],
    )

    const { body: overview } = await call<Overview>('GET', '/overview')
    const usage = overview.agents.find((entry) => entry.name === agent)?.usage
    assert.deepEqual(usage, {
      inputTokens: 11,
      outputTokens: 202,
      cacheReadTokens: 3000,
      cacheWriteTokens: 400,
      costUsd: 0.25,
      runs: 2,
      // Its runs didn't say which models they used, and its name doesn't either.
      models: {
        unknown: {
          inputTokens: 11,
          outputTokens: 202,
          cacheReadTokens: 3000,
          cacheWriteTokens: 400,
          costUsd: 0.25,
          runs: 2,
        },
      },
    })
    assert.equal(overview.boards.find((entry) => entry.id === boardId)?.tokens, 3613)
    assert.equal(overview.totals.usage.runs, overview.usage.length)
    assert.deepEqual(
      overview.usage.filter((entry) => entry.agent === agent).map((entry) => [entry.ticketId, entry.boardId]),
      [
        [ticket.id, boardId],
        [ticket.id, boardId],
      ],
    )
    // Runs from before the range don't count.
    assert.ok(
      !getOverview(7, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)).usage.some((entry) => entry.agent === agent),
    )
  })

  test('agents report the tokens each model used, and the overview adds them up per model', async () => {
    const agent = 'model-agent/opus/high'
    const ticket = await addTicket({ title: 'A' })
    const haiku = { model: 'claude-haiku-4-5', inputTokens: 5, outputTokens: 6 }
    const opus = { model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, costUsd: 1 }
    const { status, body: recorded } = await call<TokenUsage>('POST', `/tickets/${ticket.id}/usage`, {
      agent,
      inputTokens: 15,
      outputTokens: 26,
      cacheReadTokens: 300,
      costUsd: 1.5,
      models: [haiku, opus],
    })
    assert.equal(status, 201)
    // Most tokens first, with the counts left out defaulting like the run's.
    assert.deepEqual(recorded.models, [
      { ...opus, cacheWriteTokens: 0 },
      { ...haiku, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
    ])
    const { body: listed } = await call<TokenUsage[]>('GET', `/tickets/${ticket.id}/usage`)
    assert.deepEqual(listed[0].models, recorded.models)
    assert.equal(
      (
        await call('POST', `/tickets/${ticket.id}/usage`, {
          agent,
          inputTokens: 1,
          outputTokens: 1,
          models: [opus, opus],
        })
      ).status,
      400,
    )

    // A run that doesn't say counts as one of the model in the agent's name.
    await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: 1, outputTokens: 2, costUsd: 0.5 })
    const { body: overview } = await call<Overview>('GET', '/overview')
    const models = overview.agents.find((entry) => entry.name === agent)?.usage.models
    assert.deepEqual(models, {
      'claude-opus-5-5': {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        costUsd: 1,
        runs: 1,
      },
      // Its runs reported no cost for it.
      'claude-haiku-4-5': {
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
        runs: 1,
      },
      opus: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5, runs: 1 },
    })
    assert.deepEqual(
      overview.usage.filter((entry) => entry.agent === agent).map((entry) => entry.models.map((model) => model.model)),
      [['claude-opus-5-5', 'claude-haiku-4-5'], ['opus']],
    )
    assert.equal(overview.totals.usage.models.opus?.runs, 1)
  })

  test("runs of agents on other models count as the model in the agent's name, however it is written", async () => {
    const ticket = await addTicket({ title: 'A' })
    const names = {
      // Codex's own effort level.
      'codex/gpt-5-codex/minimal': 'gpt-5-codex',
      // A model name with a provider in it, and `default` for a model without effort levels.
      'opencode/openrouter/qwen/qwen3-coder/default': 'openrouter/qwen/qwen3-coder',
      // An Ollama tag.
      'local-agent/qwen3-coder:30b/default': 'qwen3-coder:30b',
      // No effort at all.
      'gemini/gemini-2.5-pro': 'gemini-2.5-pro',
    }
    for (const agent of Object.keys(names)) {
      // Local models cost nothing, so they report no cost.
      await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: 1, outputTokens: 2 })
    }

    const { body: overview } = await call<Overview>('GET', '/overview')
    for (const [agent, model] of Object.entries(names)) {
      const usage = overview.agents.find((entry) => entry.name === agent)?.usage
      assert.deepEqual(Object.keys(usage?.models ?? {}), [model], agent)
      assert.equal(usage?.costUsd, null)
    }
  })

  test('agents report runs that were not on a ticket to the board', async () => {
    const agent = 'board-token-agent'
    const ticket = await addTicket({ title: 'A' })
    const tokensBefore = (await call<Overview>('GET', '/overview')).body.boards.find(
      (entry) => entry.id === boardId,
    )?.tokens
    await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: 1, outputTokens: 2 })
    const { status, body: recorded } = await call<TokenUsage>('POST', `/boards/${boardId}/usage`, {
      agent,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.5,
    })
    assert.equal(status, 201)
    assert.deepEqual([recorded.boardId, recorded.ticketId, recorded.costUsd], [boardId, null, 0.5])
    assert.equal(
      (await call('POST', `/boards/${boardId}/usage`, { agent, inputTokens: -1, outputTokens: 0 })).status,
      400,
    )
    assert.equal((await call('POST', '/boards/nope/usage', { agent, inputTokens: 1, outputTokens: 1 })).status, 404)

    // The board lists runs on its tickets and its own; the ticket only its runs.
    const { body: board } = await call<TokenUsage[]>('GET', `/boards/${boardId}/usage`)
    assert.deepEqual(
      board.filter((entry) => entry.agent === agent).map((entry) => entry.ticketId),
      [ticket.id, null],
    )
    const { body: onTicket } = await call<TokenUsage[]>('GET', `/tickets/${ticket.id}/usage`)
    assert.equal(onTicket.filter((entry) => entry.agent === agent).length, 1)

    const { body: overview } = await call<Overview>('GET', '/overview')
    const usage = overview.agents.find((entry) => entry.name === agent)?.usage
    assert.deepEqual([usage?.inputTokens, usage?.outputTokens, usage?.costUsd, usage?.runs], [11, 22, 0.5, 2])
    assert.equal(overview.boards.find((entry) => entry.id === boardId)?.tokens, (tokensBefore ?? 0) + 33)
    assert.deepEqual(
      overview.usage.filter((entry) => entry.agent === agent).map((entry) => [entry.ticketId, entry.boardId]),
      [
        [ticket.id, boardId],
        [null, boardId],
      ],
    )
  })

  test('tickets add up the usage of their runs, and the overview lists them by it', async () => {
    const agent = 'ticket-usage-agent'
    const cheap = await addTicket({ title: 'Cheap', tags: ['docs'] })
    const pricey = await addTicket({ title: 'Pricey', tags: ['bug', 'ui'] })
    const unused = await addTicket({ title: 'Unused' })
    assert.deepEqual(unused.usage, { runs: 0, tokens: 0, costUsd: null })

    await call('POST', `/tickets/${cheap.id}/usage`, { agent, inputTokens: 1, outputTokens: 2 })
    await call('POST', `/tickets/${pricey.id}/usage`, {
      agent,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 1000,
      cacheWriteTokens: 50,
      costUsd: 1.25,
    })
    await call('POST', `/tickets/${pricey.id}/usage`, { agent, inputTokens: 10, outputTokens: 5, costUsd: 0.5 })

    // Cost stays unknown until a run reports one; runs that don't report one add none.
    const { body: cheapNow } = await call<Ticket>('GET', `/tickets/${cheap.id}`)
    assert.deepEqual(cheapNow.usage, { runs: 1, tokens: 3, costUsd: null })
    const { body: listed } = await call<Ticket[]>('GET', `/boards/${boardId}/tickets`)
    assert.deepEqual(listed.find((ticket) => ticket.id === pricey.id)?.usage, { runs: 2, tokens: 1185, costUsd: 1.75 })

    const { body: overview } = await call<Overview>('GET', '/overview')
    const onBoard = overview.tickets.filter((entry) => entry.boardId === boardId)
    assert.deepEqual(
      onBoard.map((entry) => [entry.number, entry.title, entry.column, entry.tags.map((tag) => tag.name), entry.usage]),
      [
        [pricey.number, 'Pricey', 'Todo', ['bug', 'ui'], { runs: 2, tokens: 1185, costUsd: 1.75 }],
        [cheap.number, 'Cheap', 'Todo', ['docs'], { runs: 1, tokens: 3, costUsd: null }],
      ],
    )
    assert.equal(onBoard[0].boardName, 'Workflow')

    // Tickets without runs within the range aren't listed.
    const later = getOverview(7, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))
    assert.ok(!later.tickets.some((entry) => entry.boardId === boardId))
  })

  test('overview hides cleared agents until they do something again', async () => {
    const agent = 'stale-agent'
    const ticket = await addTicket({ title: 'A' })
    await call('POST', `/tickets/${ticket.id}/claim`, { agent }, agent)
    const listed = async () => {
      const { body } = await call<Overview>('GET', '/overview')
      return [body.agents.some((entry) => entry.name === agent), body.hiddenAgents.includes(agent)]
    }
    assert.deepEqual(await listed(), [true, false])

    assert.equal((await call('POST', '/overview/hidden-agents', { names: [agent] })).status, 204)
    assert.deepEqual(await listed(), [false, true])
    assert.equal((await call('POST', '/overview/hidden-agents', { names: [] })).status, 400)

    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Still here' }, agent)
    assert.deepEqual(await listed(), [true, false])

    await call('POST', '/overview/hidden-agents', { names: [agent] })
    assert.equal((await call('DELETE', '/overview/hidden-agents')).status, 204)
    assert.deepEqual(await listed(), [true, false])
  })
})
