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
      reservePercent: null,
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
  const setReserve = (reservePercent: unknown) =>
    call<ClaudeUsage>('PUT', '/system/claude-usage/reserve', { reservePercent })
  const report = (limits: Record<string, unknown>[]) =>
    call<ClaudeUsage>('POST', '/system/claude-usage', { usage: { limits } }, 'agent-supervisor')
  const claimNext = () =>
    call<Ticket & ApiErrorBody>('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'a', column: 'Todo' })
  const nextWeek = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()

  test('is a percent of the week, or off', async () => {
    assert.equal((await usage()).reservePercent, null)
    for (const value of [0, 101, 50.5, '80', undefined]) {
      assert.equal((await setReserve(value)).status, 400, String(value))
    }
    const set = await setReserve(80)
    assert.equal(set.status, 200)
    assert.equal(set.body.reservePercent, 80)
    assert.equal((await usage()).reservePercent, 80)
    assert.equal((await setReserve(null)).body.reservePercent, null)
  })

  test('stops claim-next once the week is used to it, leaving tickets agents hold alone', async () => {
    const held = await addTicket({ title: 'Held' })
    await addTicket({ title: 'New' })
    await setReserve(80)
    await report([
      { kind: 'session', percent: 95, resets_at: nextWeek },
      { kind: 'weekly_all', percent: 79, resets_at: nextWeek },
    ])
    // The current session doesn't count: the reserve keeps some of the week.
    assert.equal((await usage()).reserveReached, null)
    assert.equal((await call('POST', `/tickets/${held.id}/claim`, { agent: 'a' })).status, 200)

    await report([
      { kind: 'weekly_all', percent: 83, resets_at: nextWeek },
      { kind: 'weekly_scoped', percent: 90, resets_at: nextWeek, scope: { model: { display_name: 'Opus' } } },
    ])
    // The most used weekly limit holds agents back, per-model ones included.
    const reached = await usage()
    assert.deepEqual(reached.reserveReached, { label: 'Week, Opus', percent: 90, resetsAt: nextWeek })
    const refused = await claimNext()
    assert.equal(refused.status, 404)
    assert.equal(refused.body.error.code, 'usage_reserve_reached')
    assert.match(refused.body.error.message, /Week, Opus is at 90%, and the usage reserve starts at 80%/)
    assert.deepEqual(refused.body.error.details, { limit: reached.reserveReached, reservePercent: 80 })
    // Nothing was claimed, and the ticket an agent holds is still its own.
    assert.equal((await call<Ticket[]>('GET', `/boards/${boardId}/tickets?unassigned=true`)).body.length, 1)
    assert.equal((await call<Ticket>('GET', `/tickets/${held.id}`)).body.assignee, 'a')

    // Raising the reserve, or switching it off, lets agents claim again.
    await setReserve(95)
    assert.equal((await claimNext()).body.title, 'New')
    await setReserve(null)
    await report([])
  })

  test("doesn't hold agents back on a stale report, or past a limit's reset", () => {
    const reportedAt = new Date().toISOString()
    const week = { label: 'Week, all models', percent: 90, resetsAt: nextWeek }
    const reported = { reportedAt, limits: [week], reservePercent: 80 }
    assert.deepEqual(reserveReached(reported), week)
    assert.equal(reserveReached({ ...reported, reservePercent: null }), null)
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
})
