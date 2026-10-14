import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentServices } from '@shared/domain'
import { agentsSwitchState, SUPERVISOR_OFFLINE_MS } from './agents-switch.ts'

const reportedAt = '2026-10-14T12:00:00.000Z'
const at = (ms: number) => Date.parse(reportedAt) + ms
const services = (overrides: Partial<AgentServices> = {}): AgentServices => ({
  paused: false,
  changedAt: null,
  changedBy: null,
  wanted: ['a', 'b'],
  running: ['a', 'b'],
  restart: false,
  claimErrors: [],
  reportedAt,
  handledAt: null,
  serverTime: reportedAt,
  ...overrides,
})
const names: Record<string, string> = { a: 'Alpha', b: 'Beta' }
const state = (s: AgentServices, now = at(1000)) => agentsSwitchState(s, now, (id) => names[id])

describe('agentsSwitchState', () => {
  test('is up while every wanted board runs, however many others the supervisor reports', () => {
    assert.deepEqual(state(services()), { kind: 'up', boards: 2 })
    // A board deleted since, or switched off, still reported running: not one the button waits for.
    assert.deepEqual(state(services({ running: ['a', 'b', 'gone'] })), { kind: 'up', boards: 2 })
    assert.deepEqual(state(services({ wanted: [], running: [] })), { kind: 'up', boards: 0 })
  })

  test('names the boards whose loop is down, by id when the board list has no name for it', () => {
    assert.deepEqual(state(services({ running: ['a'] })), { kind: 'missing', boards: ['Beta'] })
    assert.deepEqual(state(services({ wanted: ['a', 'new'], running: [] })), {
      kind: 'missing',
      boards: ['Alpha', 'new'],
    })
  })

  test("warns of the wanted boards whose loop runs but can't claim a ticket", () => {
    const since = '2026-10-14T11:58:00.000Z'
    const message = 'Column "In progress" not found'
    assert.deepEqual(state(services({ claimErrors: [{ boardId: 'b', message, since }] })), {
      kind: 'failing',
      boards: [{ name: 'Beta', message, since }],
    })
    // A board no longer wanted (switched off, deleted) isn't one of the agents the button stands for.
    assert.deepEqual(state(services({ claimErrors: [{ boardId: 'gone', message, since }] })), { kind: 'up', boards: 2 })
    // A loop that's down is the bigger problem, and switched off, nothing claims at all.
    const failing = { claimErrors: [{ boardId: 'a', message, since }] }
    assert.equal(state(services({ ...failing, running: ['a'] })).kind, 'missing')
    assert.equal(state(services({ ...failing, paused: true })).kind, 'paused')
  })

  test('is paused once the supervisor has seen to it, even with loops still reported', () => {
    const changedAt = '2026-10-14T11:59:00.000Z'
    assert.deepEqual(state(services({ paused: true, changedAt, handledAt: changedAt, running: [] })), {
      kind: 'paused',
    })
    assert.deepEqual(state(services({ paused: true, changedAt, handledAt: changedAt })), { kind: 'paused' })
  })

  test('is switching until the supervisor reports the switch handled, even if it reported meanwhile', () => {
    const changedAt = '2026-10-14T11:59:59.000Z'
    // Its report came after the click, but from a look it took before it: still on its way.
    const raced = services({ paused: true, changedAt, handledAt: '2026-10-14T11:00:00.000Z' })
    assert.deepEqual(state(raced), { kind: 'switching', paused: true, restart: false })
    assert.deepEqual(state(services({ changedAt, handledAt: null })), {
      kind: 'switching',
      paused: false,
      restart: false,
    })
    assert.deepEqual(state(services({ changedAt, handledAt: null, restart: true })), {
      kind: 'switching',
      paused: false,
      restart: true,
    })
    assert.deepEqual(state(services({ changedAt, handledAt: changedAt })), { kind: 'up', boards: 2 })
  })

  test("is offline when the supervisor hasn't reported for a while, by the server's clock", () => {
    assert.deepEqual(state(services({ reportedAt: null })), { kind: 'offline' })
    assert.equal(state(services(), at(SUPERVISOR_OFFLINE_MS - 1000)).kind, 'up')
    assert.equal(state(services(), at(SUPERVISOR_OFFLINE_MS + 1000)).kind, 'offline')
    // Offline wins over a switch that is on its way: nothing would see to it.
    const changedAt = '2026-10-14T12:00:01.000Z'
    assert.equal(state(services({ changedAt }), at(SUPERVISOR_OFFLINE_MS + 1000)).kind, 'offline')
  })
})
