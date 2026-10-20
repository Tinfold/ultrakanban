import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import type { AgentSuggestion, BoardDetail, Overview, TokenCounts } from '../shared/domain.ts'
import { settingReport, similarity, titleWords } from './store/suggestions.ts'
import { addTicket, boardId, call, pullRequestStatuses, useBoard } from './test-app.ts'

describe('agent suggestions', () => {
  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Suggestions',
      columns: ['Todo', 'In progress', 'Review', 'Done', 'Cancelled'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
    })
    useBoard(body.id)
  })

  const columns = { done: 'Done', cancelled: 'Cancelled', open: 'In progress' }

  /**
   * A ticket worked by `runs` (agent name, cost and input tokens or tokens by kind of each) that ended up `outcome`,
   * planned at `estimate` when given.
   */
  async function pastTicket(
    title: string,
    outcome: keyof typeof columns,
    runs: [agent: string, costUsd: number | null, tokens?: number | Partial<TokenCounts>][],
    { estimate, ...input }: Record<string, unknown> = {},
  ) {
    const ticket = await addTicket({ title, column: columns[outcome], force: true, ...input })
    if (estimate) await call('POST', `/tickets/${ticket.id}/plan`, { agent: 'claude/opus/high', estimate, plan: 'x' })
    for (const [agent, costUsd, tokens = 1000] of runs) {
      const counts = typeof tokens === 'number' ? { inputTokens: tokens } : tokens
      await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: 0, outputTokens: 0, ...counts, costUsd })
    }
    return ticket
  }

  const suggest = async (params: string) =>
    (await call<AgentSuggestion>('GET', `/boards/${boardId}/agent-suggestion?${params}`)).body
  const settings = (result: AgentSuggestion) => result.options.map((option) => `${option.model}/${option.effort}`)

  test('suggests the cheapest setting that finishes similar tickets', async () => {
    const sonnet = await pastTicket('Fix flaky login test', 'done', [['claude/sonnet/medium', 0.5]], { tags: ['bug'] })
    const sonnet2 = await pastTicket('Fix login form', 'done', [['claude/sonnet/medium', 0.7]], { tags: ['bug'] })
    await pastTicket('Fix login redirect bug', 'done', [['claude/opus/high', 3]], { tags: ['bug'] })
    await pastTicket('Fix login logout bug', 'done', [['claude/opus/high', 3]], { tags: ['bug'] })
    await pastTicket('Fix login page crash', 'cancelled', [['claude/haiku/low', 0.1]], { tags: ['bug'] })
    // Nothing in common with the new ticket, so it doesn't count however cheap it was.
    await pastTicket('Redesign dashboard charts', 'done', [['claude/haiku/low', 0.05]], { tags: ['ui'] })

    const result = await suggest('title=Fix+login+timeout&tag=bug')
    assert.deepEqual(settings(result), ['sonnet/medium', 'opus/high', 'haiku/low'])
    assert.deepEqual(result.suggestion, result.options[0])
    const [form, flaky] = result.suggestion!.similar
    // Its average is weighted by similarity, and the shorter title shares more of its words.
    assert.ok(form.similarity > flaky.similarity)
    const costUsd = (0.7 * form.similarity + 0.5 * flaky.similarity) / (form.similarity + flaky.similarity)
    assert.deepEqual(result.suggestion, {
      model: 'sonnet',
      effort: 'medium',
      tickets: 2,
      finished: 2,
      successRate: 1,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      costPerFinishedUsd: Math.round(costUsd * 1e6) / 1e6,
      tokens: 1000,
      weightedTokens: 1000,
      weightedTokensPerFinished: 1000,
      similar: [
        {
          id: sonnet2.id,
          number: sonnet2.number,
          title: 'Fix login form',
          similarity: form.similarity,
          finished: true,
          costUsd: 0.7,
          tokens: 1000,
        },
        {
          id: sonnet.id,
          number: sonnet.number,
          title: 'Fix flaky login test',
          similarity: flaky.similarity,
          finished: true,
          costUsd: 0.5,
          tokens: 1000,
        },
      ],
    })
    const haiku = result.options[2]
    assert.deepEqual([haiku.tickets, haiku.finished, haiku.successRate], [1, 0, 0])
    assert.deepEqual([haiku.costPerFinishedUsd, haiku.weightedTokensPerFinished], [null, null])
  })

  test('ranks settings by what a finished ticket costs, not what any ticket does', async () => {
    await pastTicket('Add export to CSV', 'done', [['claude/opus/medium', 1]])
    await pastTicket('Add export to JSON', 'done', [['claude/opus/medium', 1]])
    // Cheaper per ticket, but one in six is given up on, so each finished ticket costs 0.9 / (5/6) = 1.08.
    for (const format of ['PDF', 'XML', 'TSV', 'HTML', 'XLSX']) {
      await pastTicket(`Add export to ${format}`, 'done', [['claude/sonnet/medium', 0.9]])
    }
    await pastTicket('Add export to ODS', 'cancelled', [['claude/sonnet/medium', 0.9]])

    const result = await suggest('title=Add+export+to+YAML')
    assert.deepEqual(settings(result), ['opus/medium', 'sonnet/medium'])
    assert.deepEqual([result.suggestion?.costUsd, result.suggestion?.costPerFinishedUsd], [1, 1])
    const sonnet = result.options[1]
    assert.deepEqual([sonnet.successRate, sonnet.costUsd, sonnet.costPerFinishedUsd], [0.833, 0.9, 1.08])
  })

  test('suggests only a setting enough similar tickets were worked at', async () => {
    await pastTicket('Add dark mode toggle', 'done', [['claude/haiku/low', 0.01]])
    await pastTicket('Add compact mode toggle', 'done', [['claude/sonnet/medium', 0.5]])
    assert.equal((await suggest('title=Add+focus+mode+toggle')).suggestion, null)

    await pastTicket('Add sound toggle', 'done', [['claude/sonnet/medium', 0.5]])
    const result = await suggest('title=Add+focus+mode+toggle')
    // The cheaper setting still shows, worked at a single similar ticket.
    assert.deepEqual(settings(result), ['sonnet/medium', 'haiku/low'])
    assert.equal(result.suggestion?.tickets, 2)
  })

  test("weighs past tickets by how close their plan's estimate is", async () => {
    const small = await pastTicket('Add export to CSV', 'done', [['claude/sonnet/medium', 0.5]], { estimate: 'S' })
    const large = await pastTicket('Add export to PDF', 'done', [['claude/sonnet/medium', 0.5]], { estimate: 'L' })
    const order = async (params: string) =>
      (await suggest(`title=Add+export+to+YAML${params}`)).suggestion!.similar.map((ticket) => ticket.id)

    // Without an estimate both are as similar, so the newer comes first.
    assert.deepEqual(await order(''), [large.id, small.id])
    assert.deepEqual(await order('&estimate=S'), [small.id, large.id])
    assert.deepEqual(await order('&estimate=L'), [large.id, small.id])
    assert.equal((await call('GET', `/boards/${boardId}/agent-suggestion?estimate=XL`)).status, 400)
  })

  test('a cheaper setting that finishes less of the work loses to a dearer one that finishes it', async () => {
    await pastTicket('Add export to CSV', 'done', [['claude/opus/high', 2]])
    await pastTicket('Add export to JSON', 'done', [['claude/opus/high', 2.5]])
    await pastTicket('Add export to PDF', 'done', [['claude/sonnet/medium', 0.4]])
    const closed = await pastTicket('Add export to XML', 'open', [['claude/sonnet/medium', 0.3]], {
      pullRequest: 'https://github.com/acme/app/pull/7',
    })
    pullRequestStatuses.set('https://github.com/acme/app/pull/7', { state: 'closed', title: 'XML export' })
    await call('POST', `/tickets/${closed.id}/pull-request/sync`)
    pullRequestStatuses.clear()

    const result = await suggest('title=Add+export+to+YAML')
    assert.deepEqual(settings(result), ['opus/high', 'sonnet/medium'])
    assert.deepEqual([result.options[1].tickets, result.options[1].finished], [2, 1])
    assert.equal(result.suggestion?.costUsd, 2.25)
  })

  test('counts only decided tickets, by the setting that did most of their work', async () => {
    await pastTicket('Speed up board loading', 'open', [['claude/haiku/low', 0.01]])
    await pastTicket('Speed up ticket search', 'done', [['someone', 0.01]])
    await pastTicket('Speed up activity feed', 'done', [
      ['claude/sonnet/low', 0.2, 500],
      ['claude/opus/medium', 1, 5000],
      ['claude/opus/medium', 1, 5000],
    ])
    // Tokens count by kind: these cache reads weigh 50_000 * 0.1, less than the other setting's input.
    await pastTicket('Speed up activity search', 'done', [
      ['claude/haiku/low', 0.1, { cacheReadTokens: 50_000 }],
      ['claude/opus/medium', 1, 6000],
    ])

    const result = await suggest('title=Speed+up+the+overview')
    assert.deepEqual(settings(result), ['opus/medium'])
    assert.equal(result.suggestion?.tickets, 2)
    // All their runs count towards their cost.
    const [search, feed] = result.suggestion!.similar
    assert.deepEqual([feed.costUsd, feed.tokens, search.costUsd, search.tokens], [2.2, 10_500, 1.1, 56_000])
  })

  test("counts only tickets the board's own agent did most of the work on", async () => {
    // Other agents run models the board's agent can't, whatever they call their effort.
    await pastTicket('Tidy up the settings page', 'done', [['codex/gpt-5-codex/high', 0.1]])
    await pastTicket('Tidy up the setup page', 'done', [
      ['gemini/gemini-2.5-pro/default', null, 9000],
      ['claude/haiku/low', 0.01],
    ])
    // Its model can be any the endpoint it uses serves.
    await pastTicket('Tidy up the overview page', 'done', [['claude/openrouter/qwen/qwen3-coder/medium', 0.2]])
    assert.deepEqual(settings(await suggest('title=Tidy+up+the+board+page')), ['openrouter/qwen/qwen3-coder/medium'])

    // Under another name, only the runs under that name count.
    await pastTicket('Tidy up the epics page', 'done', [['bot/sonnet/high', 0.3]])
    await call('PATCH', `/boards/${boardId}`, { agentName: 'bot' })
    assert.deepEqual(settings(await suggest('title=Tidy+up+the+board+page')), ['sonnet/high'])
  })

  test('compares by tokens weighted by kind when runs reported no cost', async () => {
    // Fewer tokens, but output: 20_000 * 5 weighted.
    await pastTicket('Rename column setting', 'done', [['claude/opus/high', null, { outputTokens: 20_000 }]])
    await pastTicket('Rename board setting', 'done', [['claude/opus/high', null, { outputTokens: 20_000 }]])
    // More tokens, but mostly cache reads: 150_000 * 0.1 + 5_000 weighted.
    const cached = { cacheReadTokens: 150_000, inputTokens: 5_000 }
    await pastTicket('Rename tag color setting', 'done', [['claude/haiku/low', null, cached]])
    await pastTicket('Rename epic setting', 'done', [['claude/haiku/low', null, cached]])

    const result = await suggest('title=Rename+tag+setting')
    assert.deepEqual(settings(result), ['haiku/low', 'opus/high'])
    const [haiku, opus] = result.options
    assert.deepEqual([haiku.costUsd, haiku.costPerFinishedUsd], [null, null])
    assert.deepEqual([haiku.tokens, haiku.weightedTokens, haiku.weightedTokensPerFinished], [155_000, 20_000, 20_000])
    assert.deepEqual([opus.tokens, opus.weightedTokens], [20_000, 100_000])
  })

  test('suggests nothing without similar finished tickets', async () => {
    const { suggestion, options } = await suggest('title=Anything')
    assert.deepEqual({ suggestion, options }, { suggestion: null, options: [] })

    await pastTicket('Migrate the database', 'cancelled', [['claude/opus/high', 4]], { tags: ['infra'] })
    const failed = await suggest('title=Migrate+the+queue')
    assert.equal(failed.suggestion, null)
    assert.deepEqual(settings(failed), ['opus/high'])

    // Tags match by id or name, whatever their case, and ones the board doesn't have are ignored.
    const { body: detail } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    const infra = detail.tags.find((tag) => tag.name === 'infra')!
    assert.deepEqual(settings(await suggest(`tag=${infra.id}`)), ['opus/high'])
    assert.deepEqual(settings(await suggest('tag=INFRA&tag=unknown')), ['opus/high'])
    assert.deepEqual(settings(await suggest('tag=unknown')), [])
  })

  test('rejects bad queries and unknown boards', async () => {
    assert.equal((await call('GET', `/boards/${boardId}/agent-suggestion?steps=-1`)).status, 400)
    assert.equal((await call('GET', '/boards/nope/agent-suggestion?title=x')).status, 404)
  })

  test('similarity weighs tags, title words and checklist size', () => {
    assert.deepEqual(
      [...titleWords('Show the tickets, and THEIR costs per board')],
      ['show', 'ticket', 'cost', 'board'],
    )
    const ticket = { tags: new Set(['a']), words: titleWords('Fix login'), steps: 3 }
    assert.equal(similarity(ticket, { tags: new Set(['b']), words: titleWords('Add charts'), steps: 3 }), 0)
    assert.equal(similarity(ticket, { ...ticket, steps: undefined }), 1)
    assert.equal(similarity(ticket, ticket), 1)
    const fewerSteps = similarity(ticket, { ...ticket, steps: 1 })
    const otherTag = similarity(ticket, { ...ticket, tags: new Set(['b']) })
    assert.ok(fewerSteps < 1 && otherTag < fewerSteps)

    // An estimate counts once both have one: closer sizes are more alike.
    const small = { ...ticket, estimate: 'S' as const }
    assert.equal(similarity(small, ticket), 1)
    assert.equal(similarity(small, small), 1)
    const medium = similarity(small, { ...small, estimate: 'M' })
    const large = similarity(small, { ...small, estimate: 'L' })
    assert.ok(large < medium && medium < 1)
    assert.equal(similarity(small, { ...small, tags: new Set(['b']), words: new Set() }), 0)
  })
  test('reports every decided ticket by the setting that did most of its work, on the overview too', async () => {
    await pastTicket('Fix login bug', 'done', [['claude/opus/high', 3]])
    await pastTicket('Add CSV export', 'cancelled', [['claude/opus/high', 1]])
    await pastTicket('Write release notes', 'done', [
      ['claude/sonnet/medium', 0.4, 5000],
      ['claude/opus/high', 0.6, 1000],
    ])
    // Another agent's work counts too, unlike in suggestions; work still in progress doesn't.
    await pastTicket('Port the parser', 'done', [['codex/gpt-5.1-codex/medium', null, 2000]])
    await pastTicket('Speed up board loading', 'open', [['claude/haiku/low', 0.01]])

    const report = settingReport([boardId])
    const cost = (costUsd: number | null, costPerFinishedUsd: number | null) => ({ costUsd, costPerFinishedUsd })
    const tokens = (tokens: number, perFinished: number) => ({
      tokens,
      weightedTokens: tokens,
      weightedTokensPerFinished: perFinished,
    })
    assert.deepEqual(report, [
      {
        model: 'opus',
        effort: 'high',
        tickets: 2,
        finished: 1,
        successRate: 0.5,
        ...cost(2, 4),
        ...tokens(1000, 2000),
      },
      {
        model: 'gpt-5.1-codex',
        effort: 'medium',
        tickets: 1,
        finished: 1,
        successRate: 1,
        ...cost(null, null),
        ...tokens(2000, 2000),
      },
      {
        model: 'sonnet',
        effort: 'medium',
        tickets: 1,
        finished: 1,
        successRate: 1,
        ...cost(1, 1),
        ...tokens(6000, 6000),
      },
    ])
    const { body: overview } = await call<Overview>('GET', '/overview')
    for (const setting of report) assert.ok(overview.settings.some((entry) => entry.model === setting.model))
  })
})
