import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentServices } from '../shared/domain.ts'
import { app, call, github } from './test-app.ts'

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

  test('turns down anything but a boolean switch, and leaves the switch as it was', async () => {
    const before = await status()
    for (const body of [{}, { paused: null }, { paused: 'false' }, { paused: 0 }, { paused: [] }, []]) {
      assert.equal((await call('PUT', '/system/agents/services', body)).status, 400, JSON.stringify(body))
    }
    for (const body of ['{"paused":', 'not json', '']) {
      const res = await app.request('/api/system/agents/services', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      })
      assert.equal(res.status, 400, body)
    }
    assert.deepEqual(
      { paused: (await status()).paused, changedAt: (await status()).changedAt },
      { paused: before.paused, changedAt: before.changedAt },
    )
  })

  test('turns down malformed reports, and keeps the last good one', async () => {
    await report({ running: ['keep'], handledAt: null })
    for (const body of [
      { running: 'a' },
      { running: [1] },
      { running: ['x'.repeat(101)] },
      { running: Array.from({ length: 10_001 }, (_, i) => `b${i}`) },
      { running: [], handledAt: 'x'.repeat(101) },
      { running: [], handledAt: 5 },
    ]) {
      assert.equal((await report(body)).status, 400)
    }
    assert.deepEqual((await status()).running, ['keep'])
  })

  test('echoes the switch the supervisor saw to, and the server time to judge its report by', async () => {
    const { body: switched } = await call<AgentServices>('PUT', '/system/agents/services', { paused: true })
    const before = Date.now()
    const { body } = await report({ running: [], handledAt: switched.changedAt })
    assert.equal(body.handledAt, switched.changedAt)
    assert.ok(Math.abs(Date.parse(body.serverTime) - before) < 5000)
    // An older supervisor (or one that hasn't read the switch) reports without it.
    assert.equal((await report({ running: [] })).body.handledAt, null)
    await call('PUT', '/system/agents/services', { paused: false })
  })

  test('the last of many quick switches wins, from any number of tabs at once', async () => {
    const order = Array.from({ length: 25 }, (_, i) => i % 2 === 0)
    await Promise.all(order.map((paused) => call('PUT', '/system/agents/services', { paused })))
    const settled = await status()
    assert.equal(typeof settled.paused, 'boolean')
    for (const paused of [true, false, true, true, false]) {
      assert.equal((await call<AgentServices>('PUT', '/system/agents/services', { paused })).body.paused, paused)
    }
    assert.equal((await status()).paused, false)
  })

  test("follows the boards: deleted ones, and ones whose agent is switched off, aren't wanted", async () => {
    github.repos.add('acme/churn')
    const make = async (name: string) => {
      const { body } = await call<{ id: string }>('POST', '/boards', { name, columns: ['Todo'] })
      await call('PATCH', `/boards/${body.id}`, { githubRepo: 'acme/churn', agentEnabled: true })
      return body.id
    }
    const [deleted, agentOff] = [await make('Deleted'), await make('Agent off')]
    const wanted = async () => (await status()).wanted
    for (const id of [deleted, agentOff]) assert.ok((await wanted()).includes(id))
    // A board can't lose its repository while its agent is on, so it can't be wanted without one.
    assert.equal((await call('PATCH', `/boards/${agentOff}`, { githubRepo: null })).status, 400)
    await call('DELETE', `/boards/${deleted}`)
    await call('PATCH', `/boards/${agentOff}`, { agentEnabled: false })
    for (const id of [deleted, agentOff]) assert.ok(!(await wanted()).includes(id), id)
  })
})
