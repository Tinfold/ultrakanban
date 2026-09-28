import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import type { AgentSuggestion, BoardDetail } from '../shared/domain.ts'
import { similarity, titleWords } from './store/suggestions.ts'
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

  /** A ticket worked by `runs` (agent name and cost of each) that ended up `outcome`. */
  async function pastTicket(
    title: string,
    outcome: keyof typeof columns,
    runs: [agent: string, costUsd: number | null, tokens?: number][],
    input: Record<string, unknown> = {},
  ) {
    const ticket = await addTicket({ title, column: columns[outcome], force: true, ...input })
    for (const [agent, costUsd, tokens = 1000] of runs) {
      await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: tokens, outputTokens: 0, costUsd })
    }
    return ticket
  }

  const suggest = async (params: string) =>
    (await call<AgentSuggestion>('GET', `/boards/${boardId}/agent-suggestion?${params}`)).body
  const settings = (result: AgentSuggestion) => result.options.map((option) => `${option.model}/${option.effort}`)

  test('suggests the cheapest setting that finishes similar tickets', async () => {
    const sonnet = await pastTicket('Fix flaky login test', 'done', [['claude/sonnet/medium', 0.5]], { tags: ['bug'] })
    await pastTicket('Fix login redirect bug', 'done', [['claude/opus/high', 3]], { tags: ['bug'] })
    await pastTicket('Fix login page crash', 'cancelled', [['claude/haiku/low', 0.1]], { tags: ['bug'] })
    // Nothing in common with the new ticket, so it doesn't count however cheap it was.
    await pastTicket('Redesign dashboard charts', 'done', [['claude/haiku/low', 0.05]], { tags: ['ui'] })

    const result = await suggest('title=Fix+login+timeout&tag=bug')
    assert.deepEqual(settings(result), ['sonnet/medium', 'opus/high', 'haiku/low'])
    assert.deepEqual(result.suggestion, result.options[0])
    assert.deepEqual(result.suggestion, {
      model: 'sonnet',
      effort: 'medium',
      tickets: 1,
      finished: 1,
      successRate: 1,
      costUsd: 0.5,
      tokens: 1000,
      similar: [
        {
          id: sonnet.id,
          number: sonnet.number,
          title: 'Fix flaky login test',
          similarity: result.suggestion!.similar[0].similarity,
          finished: true,
          costUsd: 0.5,
          tokens: 1000,
        },
      ],
    })
    const haiku = result.options[2]
    assert.deepEqual([haiku.tickets, haiku.finished, haiku.successRate], [1, 0, 0])
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

    const result = await suggest('title=Speed+up+the+overview')
    assert.deepEqual(settings(result), ['opus/medium'])
    assert.equal(result.suggestion?.tickets, 1)
    // All its runs count towards its cost.
    assert.deepEqual([result.suggestion?.costUsd, result.suggestion?.tokens], [2.2, 10_500])
  })

  test('compares by tokens when runs reported no cost', async () => {
    await pastTicket('Rename column setting', 'done', [['claude/opus/high', null, 90_000]])
    await pastTicket('Rename board setting', 'done', [['claude/haiku/low', null, 20_000]])

    const result = await suggest('title=Rename+tag+setting')
    assert.deepEqual(settings(result), ['haiku/low', 'opus/high'])
    assert.equal(result.suggestion?.costUsd, null)
  })

  test('suggests nothing without similar finished tickets', async () => {
    assert.deepEqual(await suggest('title=Anything'), { suggestion: null, options: [] })

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
  })
})
