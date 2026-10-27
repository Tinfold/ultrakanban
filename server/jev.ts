import { typesafeBase, typesafeKey } from './typesafe.ts'

/** The pinned Jev model: a versioned one, so routing doesn't change under us when `jev-latest` moves. */
export const JEV_MODEL = 'jev-1.14.0'
export const JEV_TIMEOUT_MS = 2000

export type JevQuestion =
  | { id: string; type: 'choice'; question: string; options: { name: string; description?: string }[] }
  | { id: string; type: 'score'; question: string; levels: { name: string; description?: string }[] }
  | { id: string; type: 'noul'; question: string }

export type JevAnswer =
  | { id: string; type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      id: string
      type: 'score'
      score: string
      probabilities: Record<string, number>
      confidence: number
      legend: unknown
    }
  | { id: string; type: 'noul'; probability: number }

export interface JevUsage {
  inputTokens: number
  outputTokens: number
}
export interface JevResult {
  answers: JevAnswer[]
  usage: JevUsage
}

type WireAnswer = {
  type: string
  choice?: string
  score?: number
  noul?: number
  confidence?: number
  probabilities?: Record<string, number>
}

/** The questions as `/v1/systemone` takes them: an object keyed by id, with each option or level in `criteria`. */
export function toWireQuestions(questions: JevQuestion[]) {
  const describe = (name: string, description?: string) => (description ? `${name}: ${description}` : name)
  return Object.fromEntries(
    questions.map((question) => {
      if (question.type === 'choice') {
        const criteria = Object.fromEntries(question.options.map((o) => [o.name, o.description ?? o.name]))
        return [question.id, { type: 'choice', question: question.question, criteria }]
      }
      if (question.type === 'score') {
        const criteria = question.levels.map((level) => describe(level.name, level.description))
        return [question.id, { type: 'score', question: question.question, criteria }]
      }
      return [question.id, { type: 'noul', question: question.question, instructions: question.question }]
    }),
  )
}

/** The answers as `answers` arrive (an object keyed by id, a score as a level's index) turned back into `JevAnswer`s. */
export function fromWireAnswers(wire: Record<string, WireAnswer>, questions: JevQuestion[]): JevAnswer[] {
  return questions.flatMap((question): JevAnswer[] => {
    const entry = wire[question.id]
    if (!entry || entry.type !== question.type) return []
    if (question.type === 'choice' && typeof entry.choice === 'string') {
      return [
        {
          id: question.id,
          type: 'choice',
          choice: entry.choice,
          probabilities: entry.probabilities ?? {},
          confidence: entry.confidence ?? 0,
        },
      ]
    }
    if (question.type === 'score' && typeof entry.score === 'number') {
      const names = question.levels.map((level) => level.name)
      const name = names[Math.round(entry.score)]
      if (!name) return []
      const probabilities = Object.fromEntries(
        Object.entries(entry.probabilities ?? {}).flatMap(([index, p]) =>
          names[Number(index)] ? [[names[Number(index)], p]] : [],
        ),
      )
      return [
        { id: question.id, type: 'score', score: name, probabilities, confidence: entry.confidence ?? 0, legend: null },
      ]
    }
    if (question.type === 'noul' && typeof entry.noul === 'number') {
      return [{ id: question.id, type: 'noul', probability: entry.noul }]
    }
    return []
  })
}

/** The `fetch` Jev is called with; tests swap in a fake so they never reach the network. */
let fetchImpl: typeof fetch = (input, init) => fetch(input, init)
export const setJevFetch = (impl: typeof fetch | null) => void (fetchImpl = impl ?? ((i, n) => fetch(i, n)))

/**
 * Asks Jev the questions about `state` (one request, all answered against it). Any failure (no key, timeout, 4xx/5xx,
 * an unreadable response) is logged and returns null: callers fall back to another source and never see an error.
 */
export async function systemOne(state: unknown, questions: JevQuestion[]): Promise<JevResult | null> {
  const key = typesafeKey()?.key
  if (!key) {
    console.warn('Jev: no TypeSafe API key')
    return null
  }
  try {
    const response = await fetchImpl(`${typesafeBase()}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions: toWireQuestions(questions) }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`TypeSafe responded ${response.status}`)
    const data = (await response.json()) as {
      answers?: Record<string, WireAnswer>
      usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number }
    }
    if (!data.answers || typeof data.answers !== 'object') throw new Error('no answers in the response')
    return {
      answers: fromWireAnswers(data.answers, questions),
      usage: {
        inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    }
  } catch (error) {
    console.warn(`Jev: ${(error as Error).message}`)
    return null
  }
}
