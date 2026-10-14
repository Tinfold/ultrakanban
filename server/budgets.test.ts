import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Activity, ApiErrorBody, BoardDetail, BoardSummary, Ticket } from '../shared/domain.ts'
import { addTicket, boardId, call, notifications, useBoard } from './test-app.ts'

describe('ticket budgets', () => {
  const spend = (ticketId: string, costUsd: number | null) =>
    call('POST', `/tickets/${ticketId}/usage`, { agent: 'claude/opus/high', inputTokens: 1, outputTokens: 1, costUsd })
  const getTicket = async (ticketId: string) => (await call<Ticket>('GET', `/tickets/${ticketId}`)).body
  const claimNext = () =>
    call<Ticket & ApiErrorBody>('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'a', column: 'Todo' })

  test("caps a ticket at its own budget, or else its board's", async () => {
    const ticket = await addTicket({ title: 'Capped' })
    assert.deepEqual([ticket.budgetUsd, ticket.budget], [null, null])

    const board = await call<BoardSummary>('PATCH', `/boards/${boardId}`, { ticketBudgetUsd: 5 })
    assert.equal(board.body.ticketBudgetUsd, 5)
    assert.deepEqual((await getTicket(ticket.id)).budget, { limitUsd: 5, spentUsd: 0, over: false })

    const own = await call<Ticket>('PATCH', `/tickets/${ticket.id}`, { budgetUsd: 2 })
    assert.deepEqual([own.body.budgetUsd, own.body.budget], [2, { limitUsd: 2, spentUsd: 0, over: false }])
    // Runs that report no cost add nothing.
    await spend(ticket.id, 1.5)
    await spend(ticket.id, null)
    assert.deepEqual((await getTicket(ticket.id)).budget, { limitUsd: 2, spentUsd: 1.5, over: false })
    await spend(ticket.id, 0.5)
    assert.deepEqual((await getTicket(ticket.id)).budget, { limitUsd: 2, spentUsd: 2, over: true })

    // Clearing the ticket's own budget goes back to the board's; clearing that one too leaves no cap.
    const cleared = await call<Ticket>('PATCH', `/tickets/${ticket.id}`, { budgetUsd: null })
    assert.deepEqual(cleared.body.budget, { limitUsd: 5, spentUsd: 2, over: false })
    await call('PATCH', `/boards/${boardId}`, { ticketBudgetUsd: null })
    assert.equal((await getTicket(ticket.id)).budget, null)

    // Logged as an edit (merged into one entry, as edits close together are).
    const { body: activity } = await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)
    assert.deepEqual(
      activity.flatMap((entry) => (entry.type === 'updated' ? entry.data.fields : [])),
      ['budgetUsd'],
    )
  })

  test('takes budgets from a cent up', async () => {
    const ticket = await addTicket({ title: 'Valid' })
    for (const budgetUsd of [0, -1, 0.001, 'five', 2_000_000]) {
      assert.equal((await call('PATCH', `/tickets/${ticket.id}`, { budgetUsd })).status, 400, String(budgetUsd))
      assert.equal((await call('PATCH', `/boards/${boardId}`, { ticketBudgetUsd: budgetUsd })).status, 400)
    }
    const created = await addTicket({ title: 'With a budget', budgetUsd: 0.5 })
    assert.equal(created.budgetUsd, 0.5)
  })

  test('claim-next skips tickets whose runs used up their budget', async () => {
    const spent = await addTicket({ title: 'Spent', priority: 'urgent', budgetUsd: 1 })
    await spend(spent.id, 1)
    const uncapped = await addTicket({ title: 'Uncapped', priority: 'low' })
    await spend(uncapped.id, 50)

    assert.equal((await claimNext()).body.title, 'Uncapped')
    const none = await claimNext()
    assert.equal(none.status, 404)
    assert.equal(none.body.error.code, 'no_ticket_available')

    // A board default caps tickets without a budget of their own, and raising a ticket's lets it be claimed again.
    await call('POST', `/tickets/${uncapped.id}/release`, { agent: 'a' })
    await call('PATCH', `/boards/${boardId}`, { ticketBudgetUsd: 10 })
    assert.equal((await claimNext()).status, 404)
    await call('PATCH', `/tickets/${spent.id}`, { budgetUsd: 3 })
    assert.equal((await claimNext()).body.title, 'Spent')
  })

  test('the run that uses up a ticket’s budget notifies, once', async () => {
    const { body: board } = await call<{ id: string }>('POST', '/boards', {
      name: 'Budgets',
      columns: ['Todo', 'Done'],
      notifyUrl: 'https://ntfy.sh/budgets',
      ticketBudgetUsd: 1,
    })
    useBoard(board.id)
    const ticket = await addTicket({ title: 'Pricey' })
    const sent = () => notifications.filter((notification) => notification.boardId === board.id)

    await spend(ticket.id, 0.6)
    assert.deepEqual(sent(), [])
    await spend(ticket.id, 0.6)
    assert.deepEqual(
      sent().map(({ kind, title }) => [kind, title]),
      [['budget', `#${ticket.number} used up its budget: Pricey`]],
    )
    assert.match(sent()[0].message, /cost an estimated \$1\.20, which uses up the board's budget of \$1\.00 per ticket/)
    await spend(ticket.id, 0.1)
    assert.equal(sent().length, 1)

    // Raised, it notifies again when a run uses up the new budget.
    await call('PATCH', `/tickets/${ticket.id}`, { budgetUsd: 2 })
    await spend(ticket.id, 1)
    assert.equal(sent().length, 2)
    assert.match(sent()[1].message, /\$2\.30, which uses up its \$2\.00 budget/)
  })

  test('travel with an exported board', async () => {
    await addTicket({ title: 'Budgeted', budgetUsd: 4 })
    const { body: exported } = await call<{ tickets: { budgetUsd: number | null }[] }>(
      'GET',
      `/boards/${boardId}/export`,
    )
    assert.deepEqual(
      exported.tickets.map((ticket) => ticket.budgetUsd),
      [4],
    )
    const { body: imported } = await call<BoardSummary>('POST', '/boards/import', exported)
    const { body: detail } = await call<BoardDetail>('GET', `/boards/${imported.id}`)
    assert.deepEqual(
      detail.tickets.map((ticket) => ticket.budgetUsd),
      [4],
    )
  })
})
