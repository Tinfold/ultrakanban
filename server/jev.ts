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
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`TypeSafe responded ${response.status}`)
    const data = (await response.json()) as {
      answers?: JevAnswer[]
      usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number }
    }
    if (!Array.isArray(data.answers)) throw new Error('no answers in the response')
    return {
      answers: data.answers,
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
