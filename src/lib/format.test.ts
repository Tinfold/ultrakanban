import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatBytes, formatModel } from './format.ts'

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
