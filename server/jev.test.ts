import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import type { ApiErrorBody, BoardSummary } from '../shared/domain.ts'
import { JEV_MODEL, systemOne, type JevQuestion } from './jev.ts'
import { boardId, call, jev } from './test-app.ts'

describe('jev client', () => {
  const questions: JevQuestion[] = [
    { id: 'model', type: 'choice', question: 'Which model?', options: [{ name: 'haiku' }, { name: 'sonnet' }] },
  ]
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'ts_key'
    jev.calls.length = 0
    Object.assign(jev, { status: 200, hang: false, answers: [] })
    mock.method(console, 'warn', () => {})
  })
  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY
    mock.restoreAll()
  })

  test('returns the typed answers and the usage', async () => {
    jev.answers = [
      { id: 'model', type: 'choice', choice: 'haiku', probabilities: { haiku: 0.9, sonnet: 0.1 }, confidence: 0.8 },
    ]
    const result = await systemOne({ title: 'Fix typo' }, questions)
    assert.deepEqual(result, { answers: jev.answers, usage: { inputTokens: 1200, outputTokens: 0 } })
    assert.equal(jev.calls[0].url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(jev.calls[0].auth, 'Bearer ts_key')
    assert.equal(jev.calls[0].body.model, JEV_MODEL)
  })

  test('returns null on a timeout, an error status or no key', async () => {
    jev.hang = true
    assert.equal(await systemOne({}, questions), null)
    jev.hang = false
    for (const status of [401, 500]) {
      jev.status = status
      assert.equal(await systemOne({}, questions), null)
    }
    delete process.env.TYPESAFE_API_KEY
    jev.calls.length = 0
    assert.equal(await systemOne({}, questions), null)
    assert.equal(jev.calls.length, 0)
  })
})

describe('Route with Jev board setting', () => {
  const board = async () => (await call<{ board: BoardSummary }>('GET', `/boards/${boardId}`)).body.board
  const patch = (body: Record<string, unknown>) =>
    call<BoardSummary & ApiErrorBody>('PATCH', `/boards/${boardId}`, body)
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'ts_key'
  })
  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY
  })

  test('is off by default, with no mode until it is first switched on', async () => {
    const { jevEnabled, jevModels, jevThreshold, jevOnlyLower, jevMode } = await board()
    assert.deepEqual(
      { jevEnabled, jevModels, jevThreshold, jevOnlyLower, jevMode },
      { jevEnabled: false, jevModels: null, jevThreshold: null, jevOnlyLower: false, jevMode: null },
    )
  })

  test('starts in dry run when first switched on, and keeps the mode chosen after that', async () => {
    assert.equal((await patch({ jevEnabled: true })).body.jevMode, 'dry-run')
    assert.equal((await patch({ jevMode: 'on' })).body.jevMode, 'on')
    await patch({ jevEnabled: false })
    const again = (await patch({ jevEnabled: true })).body
    assert.equal(again.jevEnabled, true)
    assert.equal(again.jevMode, 'on')
  })

  test('takes a mode given with the switch', async () => {
    assert.equal((await patch({ jevEnabled: true, jevMode: 'on' })).body.jevMode, 'on')
  })

  test('saves the models, threshold and "may only lower" switch, and clears them back to the defaults', async () => {
    const saved = (await patch({ jevModels: ['haiku', 'sonnet'], jevThreshold: 0.85, jevOnlyLower: true })).body
    assert.deepEqual([saved.jevModels, saved.jevThreshold, saved.jevOnlyLower], [['haiku', 'sonnet'], 0.85, true])
    const cleared = (await patch({ jevModels: null, jevThreshold: null, jevOnlyLower: false })).body
    assert.deepEqual([cleared.jevModels, cleared.jevThreshold, cleared.jevOnlyLower], [null, null, false])
  })

  test('turns down unknown models, an empty list, thresholds outside 0 to 1 and unknown modes', async () => {
    for (const body of [
      { jevModels: ['gpt-5'] },
      { jevModels: [] },
      { jevModels: ['opus', 'opus'] },
      { jevThreshold: 1.5 },
      { jevThreshold: -0.1 },
      { jevMode: 'off' },
    ]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body))
    }
  })

  test("can't be switched on without a TypeSafe key, but can be switched off", async () => {
    await patch({ jevEnabled: true })
    delete process.env.TYPESAFE_API_KEY
    const refused = await patch({ jevEnabled: true })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error.message, /TypeSafe API key/)
    assert.equal((await patch({ jevEnabled: false })).body.jevEnabled, false)
    assert.equal((await board()).jevEnabled, false)
  })
})
