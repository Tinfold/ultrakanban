import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ApiErrorBody, ClaudeUsage, Ticket } from '../shared/domain.ts'
import { parseClaudeCredits, parseClaudeUsage, reserveReached } from './store/claude-usage.ts'
import { addTicket, boardId, call } from './test-app.ts'

describe('Claude usage', () => {
  const usage = async () => (await call<ClaudeUsage>('GET', '/system/claude-usage')).body
  const report = (body: Record<string, unknown>) =>
    call<ClaudeUsage>('POST', '/system/claude-usage', body, 'agent-supervisor')

  test('shows the limits the supervisor last read', async () => {
    assert.deepEqual(await usage(), {
      reportedAt: null,
      limitsAt: null,
      plan: null,
      limits: [],
      credits: [],
      error: null,
      reserve: { week: null, session: null, usageCredits: false },
      apiKey: {
        enabled: false,
        available: false,
        runBudgetUsd: 5,
        monthlyBudgetUsd: null,
        spentThisMonthUsd: 0,
        usable: false,
      },
      reserveReached: null,
    })

    const reported = await report({
      plan: 'max',
      usage: {
        five_hour: { utilization: 3, resets_at: '2026-10-05T23:00:00+00:00', limit_dollars: null },
        monthly_grant: {
          utilization: 10,
          resets_at: '2026-11-05T07:59:00+00:00',
          limit_dollars: 250,
          used_dollars: 25,
          remaining_dollars: 225,
        },
        limits: [
          { kind: 'session', percent: 3, resets_at: '2026-10-05T23:00:00+00:00' },
          { kind: 'weekly_all', percent: 46, resets_at: '2026-10-08T01:00:00+00:00' },
          { kind: 'weekly_scoped', percent: 0, resets_at: null, scope: { model: { display_name: 'Opus' } } },
          { kind: 'session', percent: 'unknown' },
        ],
      },
    })
    assert.equal(reported.status, 200)
    assert.ok(reported.body.reportedAt)
    assert.equal(reported.body.limitsAt, reported.body.reportedAt)
    assert.equal(reported.body.plan, 'max')
    assert.deepEqual(reported.body.limits, [
      { label: 'Current session', percent: 3, resetsAt: '2026-10-05T23:00:00+00:00' },
      { label: 'Week, all models', percent: 46, resetsAt: '2026-10-08T01:00:00+00:00' },
      { label: 'Week, Opus', percent: 0, resetsAt: null },
    ])

    assert.deepEqual(reported.body.credits, [
      {
        kind: 'grant',
        label: 'Credit grant',
        enabled: true,
        currency: 'USD',
        used: 25,
        limit: 250,
        remaining: 225,
        resetsAt: '2026-11-05T07:59:00+00:00',
      },
    ])

    // Without usage it keeps the limits, credits and when they were read, with an error too: one failed read doesn't clear them.
    const kept = (await report({})).body
    assert.deepEqual([kept.limits.length, kept.credits.length], [3, 1])
    const failed = await report({ error: 'No claude login on the host' })
    assert.deepEqual(
      [failed.body.limits, failed.body.credits, failed.body.limitsAt, failed.body.error, failed.body.plan],
      [reported.body.limits, reported.body.credits, reported.body.limitsAt, 'No claude login on the host', 'max'],
    )
    assert.notEqual(failed.body.reportedAt, reported.body.reportedAt)
    const read = await report({ usage: { limits: [] } })
    assert.deepEqual([read.body.limits, read.body.limitsAt, read.body.error], [[], read.body.reportedAt, null])

    assert.equal((await report({ usage: 'nope' })).status, 400)
  })

  test('falls back to the older usage fields', () => {
    assert.deepEqual(
      parseClaudeUsage({
        five_hour: { utilization: 120, resets_at: 'soon' },
        seven_day: { utilization: 46.5, resets_at: '2026-10-08T01:00:00Z' },
        seven_day_opus: null,
      }),
      [
        { label: 'Current session', percent: 100, resetsAt: null },
        { label: 'Week, all models', percent: 46.5, resetsAt: '2026-10-08T01:00:00Z' },
      ],
    )
  })
})

describe('Claude usage credits', () => {
  const spend = (fields: Record<string, unknown>) => ({
    spend: { enabled: true, used: { amount_minor: 1250, currency: 'USD', exponent: 2 }, limit: null, ...fields },
  })
  const usageCredits = { kind: 'usage', label: 'Usage credits', enabled: true, currency: 'USD', resetsAt: null }

  test('picks out credit grants and leaves out what is not one', () => {
    assert.deepEqual(
      parseClaudeCredits({
        five_hour: { utilization: 74, limit_dollars: null, used_dollars: null, remaining_dollars: null },
        grant: { resets_at: 'soon', limit_dollars: 100, remaining_dollars: 40 },
        broken: { limit_dollars: -5 },
        limits: [{ kind: 'session', percent: 3 }],
      }),
      [
        {
          kind: 'grant',
          label: 'Credit grant',
          enabled: true,
          currency: 'USD',
          used: 60,
          limit: 100,
          remaining: 40,
          resetsAt: null,
        },
      ],
    )
  })

  test('tells usage credits apart from grants, and says when they are off', () => {
    const grant = { limit_dollars: 250, used_dollars: 0, remaining_dollars: 250, resets_at: '2026-11-05T07:59:00Z' }
    assert.deepEqual(
      parseClaudeCredits({
        iguana_necktie: grant,
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
        spend: { enabled: false, used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, balance: null },
      }).map(({ kind, label, enabled, used }) => ({ kind, label, enabled, used })),
      [
        { kind: 'grant', label: 'Credit grant', enabled: true, used: 0 },
        { kind: 'usage', label: 'Usage credits', enabled: false, used: 0 },
      ],
    )
    assert.deepEqual(parseClaudeCredits({ extra_usage: { is_enabled: false } }), [
      { ...usageCredits, enabled: false, used: 0, limit: null, remaining: null },
    ])
  })

  test('reads what usage credits have spent and have left', () => {
    const credits = { ...usageCredits, used: 12.5 }
    assert.deepEqual(parseClaudeCredits(spend({})), [{ ...credits, limit: null, remaining: null }])
    assert.deepEqual(parseClaudeCredits(spend({ limit: { amount_minor: 5000, currency: 'USD', exponent: 2 } })), [
      { ...credits, limit: 50, remaining: 37.5 },
    ])
    assert.deepEqual(parseClaudeCredits(spend({ balance: { amount_minor: 800, currency: 'USD', exponent: 2 } })), [
      { ...credits, limit: null, remaining: 8 },
    ])
    // The older fields, in cents, only without `spend`.
    assert.deepEqual(
      parseClaudeCredits({
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, currency: 'EUR' },
      }),
      [{ ...credits, currency: 'EUR', limit: 50, remaining: 37.5 }],
    )
  })
})

describe('the usage reserve', () => {
  const usage = async () => (await call<ClaudeUsage>('GET', '/system/claude-usage')).body
  const setReserve = (reserve: Record<string, unknown>) =>
    call<ClaudeUsage>('PUT', '/system/claude-usage/reserve', reserve)
  const report = (limits: Record<string, unknown>[]) =>
    call<ClaudeUsage>('POST', '/system/claude-usage', { usage: { limits } }, 'agent-supervisor')
  const claimNext = () =>
    call<Ticket & ApiErrorBody>('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'a', column: 'Todo' })
  const inHours = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
  const nextWeek = inHours(3 * 24)

  test('is a percent of the week and of the current session, each or off', async () => {
    assert.deepEqual((await usage()).reserve, { week: null, session: null, usageCredits: false })
    for (const value of [0, 101, 50.5, '80']) {
      assert.equal((await setReserve({ week: value })).status, 400, String(value))
      assert.equal((await setReserve({ session: value })).status, 400, String(value))
    }
    assert.equal((await setReserve({})).status, 400)
    const set = await setReserve({ week: 80 })
    assert.equal(set.status, 200)
    assert.deepEqual(set.body.reserve, { week: 80, session: null, usageCredits: false })
    // Setting one leaves the other as it is.
    assert.deepEqual((await setReserve({ session: 90 })).body.reserve, { week: 80, session: 90, usageCredits: false })
    assert.deepEqual((await usage()).reserve, { week: 80, session: 90, usageCredits: false })
    assert.deepEqual((await setReserve({ week: null })).body.reserve, { week: null, session: 90, usageCredits: false })
    assert.deepEqual((await setReserve({ week: null, session: null })).body.reserve, {
      week: null,
      session: null,
      usageCredits: false,
    })
  })

  test('stops claim-next once the week is used to it, leaving tickets agents hold alone', async () => {
    const held = await addTicket({ title: 'Held' })
    await addTicket({ title: 'New' })
    await setReserve({ week: 80 })
    await report([
      { kind: 'session', percent: 95, resets_at: nextWeek },
      { kind: 'weekly_all', percent: 79, resets_at: nextWeek },
    ])
    // The current session has a reserve of its own, off here.
    assert.equal((await usage()).reserveReached, null)
    assert.equal((await call('POST', `/tickets/${held.id}/claim`, { agent: 'a' })).status, 200)

    await report([
      { kind: 'weekly_all', percent: 83, resets_at: nextWeek },
      { kind: 'weekly_scoped', percent: 90, resets_at: nextWeek, scope: { model: { display_name: 'Opus' } } },
    ])
    // Every weekly limit counts, per-model ones included; of two that reset together, the more used one is named.
    const reached = await usage()
    assert.deepEqual(reached.reserveReached, { label: 'Week, Opus', percent: 90, resetsAt: nextWeek })
    const refused = await claimNext()
    assert.equal(refused.status, 404)
    assert.equal(refused.body.error.code, 'usage_reserve_reached')
    assert.match(refused.body.error.message, /week's Claude usage/)
    assert.match(refused.body.error.message, /Week, Opus is at 90%, and its usage reserve starts at 80%/)
    assert.deepEqual(refused.body.error.details, { limit: reached.reserveReached, reservePercent: 80 })
    // Claiming a specific new ticket is turned down the same way; the one an agent holds can still be claimed by it.
    const fresh = (await call<Ticket[]>('GET', `/boards/${boardId}/tickets?unassigned=true`)).body[0]
    assert.equal((await call('POST', `/tickets/${fresh.id}/claim`, { agent: 'a' })).status, 404)
    assert.equal((await call('POST', `/tickets/${held.id}/claim`, { agent: 'a' })).status, 200)
    // Nothing was claimed, and the ticket an agent holds is still its own.
    assert.equal((await call<Ticket[]>('GET', `/boards/${boardId}/tickets?unassigned=true`)).body.length, 1)
    assert.equal((await call<Ticket>('GET', `/tickets/${held.id}`)).body.assignee, 'a')

    // Raising the reserve, or switching it off, lets agents claim again.
    await setReserve({ week: 95 })
    assert.equal((await claimNext()).body.title, 'New')
    await setReserve({ week: null })
    await report([])
  })

  test('stops claim-next once the current session is used to its reserve', async () => {
    await addTicket({ title: 'Next' })
    const sessionReset = inHours(2)
    await setReserve({ session: 90 })
    await report([
      { kind: 'session', percent: 92, resets_at: sessionReset },
      { kind: 'weekly_all', percent: 99, resets_at: nextWeek },
    ])
    // The week has a reserve of its own, off here.
    const reached = await usage()
    assert.deepEqual(reached.reserveReached, { label: 'Current session', percent: 92, resetsAt: sessionReset })
    const refused = await claimNext()
    assert.equal(refused.status, 404)
    assert.equal(refused.body.error.code, 'usage_reserve_reached')
    assert.match(refused.body.error.message, /current Claude session/)
    assert.match(refused.body.error.message, /Current session is at 92%, and its usage reserve starts at 90%/)
    assert.deepEqual(refused.body.error.details, { limit: reached.reserveReached, reservePercent: 90 })

    await setReserve({ session: null })
    assert.equal((await claimNext()).body.title, 'Next')
    await report([])
  })

  test('keeps holding agents back when the supervisor fails to read the usage', async () => {
    await addTicket({ title: 'Waiting' })
    await setReserve({ week: 80 })
    const read = await report([{ kind: 'weekly_all', percent: 90, resets_at: nextWeek }])
    const failed = await call<ClaudeUsage>('POST', '/system/claude-usage', { error: 'timed out' }, 'agent-supervisor')
    assert.deepEqual([failed.body.limitsAt, failed.body.reserveReached], [read.body.limitsAt, read.body.reserveReached])
    assert.ok(failed.body.reserveReached)
    assert.equal((await claimNext()).status, 404)

    await setReserve({ week: null })
    assert.equal((await claimNext()).body.title, 'Waiting')
    await report([])
  })

  test('stops claim-next once a limit is used up, unless agents may spend usage credits', async () => {
    await addTicket({ title: 'On credits' })
    assert.equal((await setReserve({ usageCredits: 'yes' })).status, 400)
    const sessionReset = inHours(2)
    await report([
      { kind: 'session', percent: 100, resets_at: sessionReset },
      { kind: 'weekly_all', percent: 40, resets_at: nextWeek },
    ])
    // With no reserve set, a used-up limit still holds agents back, so they don't run on the usage credits.
    const reached = await usage()
    assert.deepEqual(reached.reserveReached, { label: 'Current session', percent: 100, resetsAt: sessionReset })
    const refused = await claimNext()
    assert.equal(refused.status, 429)
    assert.equal(refused.body.error.code, 'usage_reserve_reached')
    assert.match(
      refused.body.error.message,
      /Current session is used up, rather than spend the account's usage credits/,
    )
    assert.deepEqual(refused.body.error.details, { limit: reached.reserveReached, reservePercent: null })

    // Allowing them leaves the reserves as they are, and lets agents claim.
    const allowed = await setReserve({ usageCredits: true })
    assert.deepEqual(allowed.body.reserve, { week: null, session: null, usageCredits: true })
    assert.equal(allowed.body.reserveReached, null)
    assert.equal((await claimNext()).body.title, 'On credits')
    // A reserve still holds them back when they may spend usage credits.
    assert.deepEqual((await setReserve({ session: 90 })).body.reserveReached?.label, 'Current session')
    await setReserve({ session: null, usageCredits: false })
    await report([])
  })

  // Stale limits fail open: a supervisor that stopped, or can't read the usage for that long, doesn't stop the agents.
  test("doesn't hold agents back on stale limits, or past a limit's reset", () => {
    const limitsAt = new Date().toISOString()
    const week = { label: 'Week, all models', percent: 90, resetsAt: nextWeek }
    const reported = { limitsAt, limits: [week], reserve: { week: 80, session: null, usageCredits: false } }
    assert.deepEqual(reserveReached(reported), week)
    assert.equal(reserveReached({ ...reported, reserve: { week: null, session: 80, usageCredits: false } }), null)
    // Used up, it holds them back without a reserve, unless they may spend usage credits.
    const usedUp = { ...reported, limits: [{ ...week, percent: 100 }] }
    assert.equal(reserveReached({ ...usedUp, reserve: { week: null, session: null, usageCredits: true } }), null)
    assert.deepEqual(reserveReached({ ...usedUp, reserve: { week: null, session: null, usageCredits: false } }), {
      ...week,
      percent: 100,
    })
    assert.equal(reserveReached({ ...reported, limitsAt: null }), null)
    // Fresh for 30 minutes: the supervisor reports every 5, so an older report means it stopped.
    assert.deepEqual(reserveReached(reported, Date.now() + 29 * 60_000), week)
    assert.equal(reserveReached(reported, Date.now() + 31 * 60_000), null)
    const resetSoon = { ...week, resetsAt: new Date(Date.now() + 60_000).toISOString() }
    assert.equal(reserveReached({ ...reported, limits: [resetSoon] }, Date.now() + 2 * 60_000), null)
    // Limits that aren't running (no reset time) still count.
    assert.deepEqual(reserveReached({ ...reported, limits: [{ ...week, resetsAt: null }] }), {
      ...week,
      resetsAt: null,
    })
    // Kinds the board doesn't know are weekly when their name says so.
    const unknownWeekly = { label: 'weekly oauth apps', percent: 85, resetsAt: null }
    assert.deepEqual(reserveReached({ ...reported, limits: [unknownWeekly] }), unknownWeekly)
  })

  test('names the limit that lifts last when both reserves hold agents back', () => {
    const session = { label: 'Current session', percent: 95, resetsAt: inHours(2) }
    const week = { label: 'Week, all models', percent: 85, resetsAt: nextWeek }
    const reported = { limitsAt: new Date().toISOString(), limits: [session, week] }
    assert.deepEqual(reserveReached({ ...reported, reserve: { week: 80, session: 90, usageCredits: false } }), week)
    assert.deepEqual(reserveReached({ ...reported, reserve: { week: 90, session: 90, usageCredits: false } }), session)
    // Once the session resets nothing does, the week being below its reserve.
    assert.equal(
      reserveReached(
        { ...reported, reserve: { week: 90, session: 90, usageCredits: false } },
        Date.now() + 3 * 3_600_000,
      ),
      null,
    )
  })
})

describe("the agents' API key", () => {
  const usage = async () => (await call<ClaudeUsage>('GET', '/system/claude-usage')).body
  const setApiKey = (body: Record<string, unknown>) => call<ClaudeUsage>('PUT', '/system/claude-usage/api-key', body)
  const checkIn = (apiKey?: boolean) =>
    call(
      'POST',
      '/system/agents',
      { runsIn: 'machine', ...(apiKey === undefined ? {} : { apiKey }) },
      'agent-supervisor',
    )
  const report = (limits: Record<string, unknown>[]) =>
    call<ClaudeUsage>('POST', '/system/claude-usage', { usage: { limits } }, 'agent-supervisor')
  const claimNext = () =>
    call<Ticket & ApiErrorBody>('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'a', column: 'Todo' })
  const spend = (ticketId: string, costUsd: number, apiKey: boolean) =>
    call('POST', `/tickets/${ticketId}/usage`, { agent: 'a', inputTokens: 1, outputTokens: 1, costUsd, apiKey })

  test('is a setting of its own, with caps, that the agents need a key for', async () => {
    for (const body of [
      {},
      { enabled: 'yes' },
      { runBudgetUsd: 0 },
      { runBudgetUsd: -1 },
      { monthlyBudgetUsd: '50' },
    ]) {
      assert.equal((await setApiKey(body)).status, 400, JSON.stringify(body))
    }
    const set = await setApiKey({ enabled: true, runBudgetUsd: 2.5, monthlyBudgetUsd: 50 })
    assert.equal(set.status, 200)
    assert.deepEqual(set.body.apiKey, {
      enabled: true,
      available: false,
      runBudgetUsd: 2.5,
      monthlyBudgetUsd: 50,
      spentThisMonthUsd: 0,
      usable: false,
    })
    // The agents checking in with a key make it usable; the check-in never has the key itself.
    assert.equal((await checkIn(true)).status, 200)
    assert.equal((await call<{ agents: { apiKey: boolean } }>('GET', '/system/setup')).body.agents.apiKey, true)
    assert.equal((await usage()).apiKey.usable, true)
    // One left out stays as it is.
    assert.deepEqual((await setApiKey({ monthlyBudgetUsd: null })).body.apiKey, {
      enabled: true,
      available: true,
      runBudgetUsd: 2.5,
      monthlyBudgetUsd: null,
      spentThisMonthUsd: 0,
      usable: true,
    })
    await checkIn()
    assert.equal((await usage()).apiKey.available, false)
    await setApiKey({ enabled: false, runBudgetUsd: 5 })
  })

  test("counts this month's spending on the key, apart from the plan's, against its monthly cap", async () => {
    const ticket = await addTicket({ title: 'Spent on' })
    await checkIn(true)
    await setApiKey({ enabled: true, monthlyBudgetUsd: 3 })
    await spend(ticket.id, 1.25, true)
    await spend(ticket.id, 7, false)
    assert.deepEqual((await usage()).apiKey.spentThisMonthUsd, 1.25)
    const runs = (await call<{ apiKey: boolean }[]>('GET', `/tickets/${ticket.id}/usage`)).body
    assert.deepEqual(
      runs.map((run) => run.apiKey),
      [true, false],
    )
    assert.equal((await usage()).apiKey.usable, true)
    await spend(ticket.id, 2, true)
    const capped = (await usage()).apiKey
    assert.equal(capped.spentThisMonthUsd, 3.25)
    assert.equal(capped.usable, false)
    await setApiKey({ enabled: false, monthlyBudgetUsd: null })
    await checkIn()
  })

  test('lets claim-next go on once a limit is used up while the key is usable, but not past a reserve', async () => {
    await addTicket({ title: 'On the key' })
    await report([{ kind: 'session', percent: 100, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() }])
    await setApiKey({ enabled: true })
    // Without a key in the agents' environment, they wait as before.
    assert.equal((await usage()).reserveReached?.label, 'Current session')
    const refused = await claimNext()
    assert.equal(refused.status, 429)
    assert.match(refused.body.error.message, /or go on on their API key if that is allowed/)

    await checkIn(true)
    assert.equal((await usage()).reserveReached, null)
    assert.equal((await claimNext()).body.title, 'On the key')
    // The usage reserve still keeps the plan's usage for people.
    const reserved = await call<ClaudeUsage>('PUT', '/system/claude-usage/reserve', { session: 90 })
    assert.equal(reserved.body.reserveReached?.label, 'Current session')
    await call('PUT', '/system/claude-usage/reserve', { session: null })
    await setApiKey({ enabled: false })
    await checkIn()
    await report([])
  })

  test('records whether a run went on the key', async () => {
    const ticket = await addTicket({ title: 'Run record' })
    const run = (apiKey?: boolean) =>
      call<{ apiKey: boolean }>('POST', `/tickets/${ticket.id}/runs`, {
        agent: 'a',
        outcome: 'finished',
        costUsd: 1,
        ...(apiKey === undefined ? {} : { apiKey }),
      })
    assert.equal((await run(true)).body.apiKey, true)
    assert.equal((await run()).body.apiKey, false)
  })
})
