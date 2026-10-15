import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { countTools, filterSteps, NO_STEP_FILTER, numberSteps } from './run-steps.ts'

const steps = [
  { tool: 'Bash', summary: 'npm test', error: true },
  { tool: 'Edit', summary: 'src/lib/format.ts', error: false },
  { tool: 'Bash', summary: 'npm run lint', error: false },
]

describe('run steps', () => {
  test('are numbered as in the run, counting the ones left out', () => {
    assert.deepEqual(
      numberSteps({ steps, omittedSteps: null }).map((step) => step.number),
      [1, 2, 3],
    )
    assert.deepEqual(
      numberSteps({ steps, omittedSteps: { after: 1, count: 40 } }).map((step) => step.number),
      [1, 42, 43],
    )
  })

  test('are filtered by tool, error and text', () => {
    const numbered = numberSteps({ steps, omittedSteps: null })
    const numbers = (filter: Partial<typeof NO_STEP_FILTER>) =>
      filterSteps(numbered, { ...NO_STEP_FILTER, ...filter }).map((step) => step.number)
    assert.deepEqual(numbers({}), [1, 2, 3])
    assert.deepEqual(numbers({ tool: 'Bash' }), [1, 3])
    assert.deepEqual(numbers({ errorsOnly: true }), [1])
    assert.deepEqual(numbers({ query: ' LINT ' }), [3])
    assert.deepEqual(numbers({ query: 'edit' }), [2])
    assert.deepEqual(numbers({ tool: 'Edit', query: 'npm' }), [])
  })

  test('count the calls of each tool, the most used first', () => {
    assert.deepEqual(countTools(steps), [
      { tool: 'Bash', count: 2 },
      { tool: 'Edit', count: 1 },
    ])
  })
})
