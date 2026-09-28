import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AGENT_EFFORTS, AGENT_MODELS, QUESTION_TAG, TICKET_TEMPLATES } from '../shared/domain.ts'
import { parseChecklist } from '../shared/checklist.ts'

describe('TICKET_TEMPLATES', () => {
  test('each template has a unique id, at least one tag, and a valid effort and model', () => {
    const ids = new Set<string>()
    for (const template of TICKET_TEMPLATES) {
      assert.ok(!ids.has(template.id), `duplicate id ${template.id}`)
      ids.add(template.id)
      assert.ok(template.tags.length > 0, `${template.id} has no tags`)
      if (template.agentEffort) assert.ok(AGENT_EFFORTS.includes(template.agentEffort))
      if (template.agentModel) assert.ok(AGENT_MODELS.includes(template.agentModel as (typeof AGENT_MODELS)[number]))
    }
  })

  test('the bug and feature templates start a checklist', () => {
    const bug = TICKET_TEMPLATES.find((t) => t.id === 'bug')!
    const feature = TICKET_TEMPLATES.find((t) => t.id === 'feature')!
    assert.ok(parseChecklist(bug.description).length > 0)
    assert.ok(parseChecklist(feature.description).length > 0)
  })

  test('the question template tags with the question tag, so it can be answered without a pull request', () => {
    const question = TICKET_TEMPLATES.find((t) => t.id === 'question')!
    assert.deepEqual(question.tags, [QUESTION_TAG])
  })
})
