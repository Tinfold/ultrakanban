import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatBytes, formatModel, formatMoney, formatRunOutcome, formatRunTotals } from './format.ts'

describe('run records', () => {
  test('say what a run took, leaving out what it did not report', () => {
    assert.equal(
      formatRunTotals({ durationMs: 23 * 60_000, turns: 41, tokens: 1_234_567, costUsd: 1.2 }),
      '23m · 41 turns · 1.2M tokens · $1.20',
    )
    assert.equal(formatRunTotals({ durationMs: 30_000, turns: 1, tokens: null, costUsd: null }), '<1m · 1 turn')
    assert.equal(formatRunTotals({ durationMs: null, turns: null, tokens: null, costUsd: null }), '')
    assert.equal(
      formatRunTotals({ durationMs: 60_000, turns: 2, tokens: null, costUsd: 0.5, apiKey: true }),
      '1m · 2 turns · $0.50 billed to the API key',
    )
    assert.equal(
      formatRunTotals({ durationMs: null, turns: null, tokens: null, costUsd: null, apiKey: true }),
      'on the API key',
    )
  })

  test('say how a run ended', () => {
    assert.equal(formatRunOutcome({ outcome: 'finished', exitCode: 0 }), 'finished')
    assert.equal(formatRunOutcome({ outcome: 'failed', exitCode: 1 }), 'failed: exit status 1')
    assert.equal(formatRunOutcome({ outcome: 'timed_out', exitCode: 124 }), 'failed: timed out')
    assert.equal(formatRunOutcome({ outcome: 'killed', exitCode: 137 }), 'failed: killed (out of memory?)')
    assert.equal(formatRunOutcome({ outcome: 'usage_limit', exitCode: 1 }), 'stopped: out of Claude usage')
  })
})

describe('formatModel', () => {
  test('reads Claude, GPT and Gemini model names, and shows others as they are', () => {
    const names = {
      'claude-opus-5-5': 'Opus 5.5',
      'claude-haiku-4-5-20251001': 'Haiku 4.5',
      'claude-sonnet-5[1m]': 'Sonnet 5 (1M)',
      opus: 'Opus',
      'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
      'gpt-4o-mini': 'GPT-4o Mini',
      gpt: 'GPT',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'gemini-3-flash-lite': 'Gemini 3 Flash Lite',
      gemini: 'Gemini',
      // Dated, local and provider-prefixed names
      'gpt-5-2025-08-07': 'gpt-5-2025-08-07',
      'gpt-oss:20b': 'gpt-oss:20b',
      'qwen3-coder:30b': 'qwen3-coder:30b',
      'openai/gpt-5': 'openai/gpt-5',
      o3: 'o3',
    }
    for (const [model, name] of Object.entries(names)) assert.equal(formatModel(model), name, model)
  })
})

describe('formatBytes', () => {
  test('counts in steps of 1024, with a decimal only below 10', () => {
    const sizes: [number, string][] = [
      [0, '0 B'],
      [950, '950 B'],
      [1023, '1023 B'],
      [1024, '1 KB'],
      [4.5 * 1024 ** 2, '4.5 MB'],
      [9.96 * 1024 ** 2, '10 MB'],
      [1023.7 * 1024, '1 MB'],
      [44.4 * 1024 ** 3, '44 GB'],
      [3 * 1024 ** 4, '3 TB'],
    ]
    for (const [bytes, text] of sizes) assert.equal(formatBytes(bytes), text, `${bytes} bytes`)
  })
})

describe('formatMoney', () => {
  test('falls back to the amount and the currency for one it does not know', () => {
    assert.equal(formatMoney(12.5, 'credits'), '12.50 credits')
  })
})
