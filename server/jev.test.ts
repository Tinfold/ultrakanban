import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import type { ApiErrorBody, BoardSummary } from '../shared/domain.ts'
import { fromWireAnswers, JEV_MODEL, systemOne, toWireQuestions, type JevQuestion } from './jev.ts'
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

  test('speaks the wire format: questions keyed by id, scores as level indexes', () => {
    const asked: JevQuestion[] = [
      ...questions,
      {
        id: 'effort',
        type: 'score',
        question: 'How much?',
        levels: [{ name: 'low', description: 'easy' }, { name: 'high' }],
      },
      { id: 'spec', type: 'noul', question: 'Fully specified.' },
    ]
    const wire = toWireQuestions(asked) as Record<string, any>
    assert.deepEqual(Object.keys(wire), ['model', 'effort', 'spec'])
    assert.deepEqual(wire.effort.criteria, ['low: easy', 'high'])
    assert.ok(wire.spec.instructions)
    const answers = fromWireAnswers(
      {
        model: { type: 'choice', choice: 'haiku', confidence: 1, probabilities: { haiku: 1, sonnet: 0 } },
        effort: { type: 'score', score: 1, confidence: 0.9, probabilities: { '0': 0.2, '1': 0.8 } },
        spec: { type: 'noul', noul: 0.3 },
      },
      asked,
    )
    assert.deepEqual(answers[1], {
      id: 'effort',
      type: 'score',
      score: 'high',
      probabilities: { low: 0.2, high: 0.8 },
      confidence: 0.9,
      legend: null,
    })
    assert.deepEqual(answers[2], { id: 'spec', type: 'noul', probability: 0.3 })
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
    const { jevEnabled, jevModels, jevThreshold, jevOnlyLower, jevCombine, jevMode } = await board()
    assert.deepEqual(
      { jevEnabled, jevModels, jevThreshold, jevOnlyLower, jevCombine, jevMode },
      { jevEnabled: false, jevModels: null, jevThreshold: null, jevOnlyLower: false, jevCombine: null, jevMode: null },
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

  test("takes the board's own Jev settings back, as Board settings sends them with every save", async () => {
    const { jevEnabled, jevModels, jevThreshold, jevOnlyLower, jevCombine, jevMode } = await board()
    const saved = await patch({
      name: 'Renamed',
      jevEnabled,
      jevModels,
      jevThreshold,
      jevOnlyLower,
      jevCombine,
      jevMode,
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.jevMode, null)
    assert.equal((await patch({ jevEnabled: true, jevMode: null })).body.jevMode, 'dry-run')
  })

  test('saves the models, threshold, "may only lower" switch and combining, and clears them back to the defaults', async () => {
    const saved = (
      await patch({ jevModels: ['haiku', 'sonnet'], jevThreshold: 0.85, jevOnlyLower: true, jevCombine: 'lower' })
    ).body
    assert.deepEqual(
      [saved.jevModels, saved.jevThreshold, saved.jevOnlyLower, saved.jevCombine],
      [['haiku', 'sonnet'], 0.85, true, 'lower'],
    )
    const cleared = (await patch({ jevModels: null, jevThreshold: null, jevOnlyLower: false, jevCombine: null })).body
    assert.deepEqual(
      [cleared.jevModels, cleared.jevThreshold, cleared.jevOnlyLower, cleared.jevCombine],
      [null, null, false, null],
    )
  })

  test('turns down unknown models, an empty list, thresholds outside 0 to 1, unknown modes and combinings', async () => {
    for (const body of [
      { jevModels: ['gpt-5'] },
      { jevModels: [] },
      { jevModels: ['opus', 'opus'] },
      { jevThreshold: 1.5 },
      { jevThreshold: -0.1 },
      { jevMode: 'off' },
      { jevCombine: 'average' },
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
