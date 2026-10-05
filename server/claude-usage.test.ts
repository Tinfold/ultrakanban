import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ClaudeUsage } from '../shared/domain.ts'
import { parseClaudeUsage } from './store/claude-usage.ts'
import { call } from './test-app.ts'

describe('Claude usage', () => {
  const usage = async () => (await call<ClaudeUsage>('GET', '/system/claude-usage')).body
  const report = (body: Record<string, unknown>) =>
    call<ClaudeUsage>('POST', '/system/claude-usage', body, 'agent-supervisor')

  test('shows the limits the supervisor last read', async () => {
    assert.deepEqual(await usage(), { reportedAt: null, plan: null, limits: [], error: null })

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
