import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AppUpdate } from '../shared/domain.ts'
import { call } from './test-app.ts'

describe('updating ultrakanban', () => {
  const status = async () => (await call<AppUpdate>('GET', '/system/update')).body
  const report = (body: Record<string, unknown>) => call<AppUpdate>('POST', '/system/update/status', body, 'supervisor')

  test('is asked for in the app and carried out by the supervisor', async () => {
    const initial = await status()
    assert.equal(initial.state, 'idle')
    assert.equal(initial.updaterSeenAt, null)

    const checkIn = await report({ version: 'abc1234 Add epics', behind: 3 })
    assert.equal(checkIn.status, 200)
    assert.equal(checkIn.body.state, 'idle')
    assert.ok(checkIn.body.updaterSeenAt)
    assert.equal(checkIn.body.behind, 3)

    // Nothing to take yet.
    assert.equal((await report({ state: 'running' })).status, 409)

    const requested = await call<AppUpdate>('POST', '/system/update', undefined, 'Ada')
    assert.equal(requested.status, 202)
    assert.equal(requested.body.state, 'requested')
    assert.equal(requested.body.requestedBy, 'Ada')
    assert.equal((await call('POST', '/system/update')).status, 409)

    assert.equal((await report({ state: 'running' })).body.state, 'running')
    assert.equal((await call('DELETE', '/system/update')).status, 409)
    assert.equal((await call('POST', '/system/update')).status, 409)

    const done = await report({ state: 'done', message: 'Updated to def5678', version: 'def5678 Fix', behind: 0 })
    assert.equal(done.body.state, 'done')
    assert.equal(done.body.message, 'Updated to def5678')
    assert.ok(done.body.finishedAt)
    assert.deepEqual(
      { version: done.body.version, behind: done.body.behind, requestedBy: done.body.requestedBy },
      { version: 'def5678 Fix', behind: 0, requestedBy: 'Ada' },
    )

    // A check-in leaves the outcome alone.
    assert.equal((await report({})).body.message, 'Updated to def5678')
  })

  test('can be withdrawn until the supervisor takes it, and asked for again after a failure', async () => {
    await call('POST', '/system/update')
    assert.equal((await call<AppUpdate>('DELETE', '/system/update')).body.state, 'idle')
    assert.equal((await report({ state: 'running' })).status, 409)

    await call('POST', '/system/update')
    await report({ state: 'running' })
    assert.equal((await report({ state: 'failed', message: 'local changes' })).body.state, 'failed')
    assert.equal((await call<AppUpdate>('POST', '/system/update')).body.message, null)
  })

  test('validates reports', async () => {
    assert.equal((await report({ state: 'requested' })).status, 400)
    assert.equal((await report({ behind: -1 })).status, 400)
  })
})
