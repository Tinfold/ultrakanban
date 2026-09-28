import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { openBlockers } from '../shared/blockers.ts'

describe('openBlockers', () => {
  const tickets = [
    { number: 1, columnId: 'todo', pullRequest: null },
    { number: 2, columnId: 'done', pullRequest: null },
    { number: 3, columnId: 'review', pullRequest: { state: 'merged' } },
    { number: 4, columnId: 'review', pullRequest: { state: 'open' } },
  ]
  const blockers = (description: string) => openBlockers({ number: 9, description }, tickets, 'done')

  test('lists the tickets it waits for that are not done yet', () => {
    assert.deepEqual(blockers('Blocked by #1, #2, #3 and #4'), [1, 4])
  })

  test('ignores missing tickets, the ticket itself and descriptions without blockers', () => {
    assert.deepEqual(blockers('Depends on #42 and #9'), [])
    assert.deepEqual(blockers('See #1'), [])
  })
})
