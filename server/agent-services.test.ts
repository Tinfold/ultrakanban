import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentServices } from '../shared/domain.ts'
import { call, github } from './test-app.ts'

describe("switching every board's agents off and on", () => {
  const status = async () => (await call<AgentServices>('GET', '/system/agents/services')).body
  const report = (body: Record<string, unknown>) =>
    call<AgentServices>('POST', '/system/agents/services/status', body, 'agent-supervisor')

  test('is switched in the app and followed by the supervisor', async () => {
    const initial = await status()
    assert.equal(initial.paused, false)
    assert.equal(initial.reportedAt, null)

    github.repos.add('acme/services')
    const { body: board } = await call<{ id: string }>('POST', '/boards', { name: 'Services', columns: ['Todo'] })
    await call('PATCH', `/boards/${board.id}`, { githubRepo: 'acme/services', agentEnabled: true })
    const { body: off } = await call<{ id: string }>('POST', '/boards', { name: 'Agent off', columns: ['Todo'] })
    assert.ok((await status()).wanted.includes(board.id))
    assert.ok(!(await status()).wanted.includes(off.id))

    const reported = await report({ running: [board.id, board.id] })
    assert.equal(reported.status, 200)
    assert.deepEqual(reported.body.running, [board.id])
    assert.ok(reported.body.reportedAt)

    const paused = await call<AgentServices>('PUT', '/system/agents/services', { paused: true }, 'Ada')
    assert.equal(paused.status, 200)
    assert.equal(paused.body.paused, true)
    assert.equal(paused.body.changedBy, 'Ada')
    assert.ok(paused.body.changedAt)
    // Still wanted: the boards' own setting is left alone, so switching back on starts the same loops.
    assert.ok(paused.body.wanted.includes(board.id))

    assert.deepEqual((await report({ running: [] })).body.running, [])
    assert.equal((await call<AgentServices>('PUT', '/system/agents/services', { paused: false })).body.paused, false)
  })

  test('validates', async () => {
    assert.equal((await call('PUT', '/system/agents/services', { paused: 'yes' })).status, 400)
    assert.equal((await report({})).status, 400)
    assert.equal((await report({ running: [''] })).status, 400)
  })
})
