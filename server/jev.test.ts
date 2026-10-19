import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { JEV_MODEL, systemOne, type JevQuestion } from './jev.ts'
import { jev } from './test-app.ts'

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
