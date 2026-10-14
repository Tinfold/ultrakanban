import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ApiErrorBody, ClaudeUsage, Ticket } from '../shared/domain.ts'
import { parseClaudeUsage, reserveReached } from './store/claude-usage.ts'
import { addTicket, boardId, call } from './test-app.ts'

describe('Claude usage', () => {
  const usage = async () => (await call<ClaudeUsage>('GET', '/system/claude-usage')).body
  const report = (body: Record<string, unknown>) =>
    call<ClaudeUsage>('POST', '/system/claude-usage', body, 'agent-supervisor')

  test('shows the limits the supervisor last read', async () => {
    assert.deepEqual(await usage(), {
      reportedAt: null,
      plan: null,
      limits: [],
      error: null,
      reserve: { week: null, session: null },
      reserveReached: null,
    })

    const reported = await report({
      plan: 'max',
      usage: {
        five_hour: { utilization: 3, resets_at: '2026-10-05T23:00:00+00:00' },
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
    assert.equal(reported.body.plan, 'max')
    assert.deepEqual(reported.body.limits, [
      { label: 'Current session', percent: 3, resetsAt: '2026-10-05T23:00:00+00:00' },
      { label: 'Week, all models', percent: 46, resetsAt: '2026-10-08T01:00:00+00:00' },
      { label: 'Week, Opus', percent: 0, resetsAt: null },
    ])

    // Without usage it keeps what it had; an error replaces it.
    assert.equal((await report({})).body.limits.length, 3)
    const failed = await report({ error: 'No claude login on the host' })
    assert.deepEqual(
      [failed.body.limits, failed.body.error, failed.body.plan],
      [[], 'No claude login on the host', 'max'],
    )
    assert.equal((await report({ usage: { limits: [] } })).body.error, null)

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
    assert.deepEqual((await usage()).reserve, { week: null, session: null })
    for (const value of [0, 101, 50.5, '80']) {
      assert.equal((await setReserve({ week: value })).status, 400, String(value))
      assert.equal((await setReserve({ session: value })).status, 400, String(value))
    }
    assert.equal((await setReserve({})).status, 400)
    const set = await setReserve({ week: 80 })
    assert.equal(set.status, 200)
    assert.deepEqual(set.body.reserve, { week: 80, session: null })
    // Setting one leaves the other as it is.
    assert.deepEqual((await setReserve({ session: 90 })).body.reserve, { week: 80, session: 90 })
    assert.deepEqual((await usage()).reserve, { week: 80, session: 90 })
    assert.deepEqual((await setReserve({ week: null })).body.reserve, { week: null, session: 90 })
    assert.deepEqual((await setReserve({ week: null, session: null })).body.reserve, { week: null, session: null })
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

  test("doesn't hold agents back on a stale report, or past a limit's reset", () => {
    const reportedAt = new Date().toISOString()
    const week = { label: 'Week, all models', percent: 90, resetsAt: nextWeek }
    const reported = { reportedAt, limits: [week], reserve: { week: 80, session: null } }
    assert.deepEqual(reserveReached(reported), week)
    assert.equal(reserveReached({ ...reported, reserve: { week: null, session: 80 } }), null)
    assert.equal(reserveReached({ ...reported, reportedAt: null }), null)
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
    const reported = { reportedAt: new Date().toISOString(), limits: [session, week] }
    assert.deepEqual(reserveReached({ ...reported, reserve: { week: 80, session: 90 } }), week)
    assert.deepEqual(reserveReached({ ...reported, reserve: { week: 90, session: 90 } }), session)
    // Once the session resets nothing does, the week being below its reserve.
    assert.equal(reserveReached({ ...reported, reserve: { week: 90, session: 90 } }, Date.now() + 3 * 3_600_000), null)
  })
})
