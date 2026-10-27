import { HttpError } from './errors.ts'
import { getStoredTypesafeKey } from './store/setup.ts'

/** Where the TypeSafe API key comes from: `TYPESAFE_API_KEY`, or the key set on the Setup page. */
export type TypesafeKeySource = 'env' | 'board'

const DEFAULT_BASE = 'https://api.typesafe.ai'

/** TypeSafe's API address; `TYPESAFE_API_BASE` points it at a LiteLLM or other proxy. */
export const typesafeBase = () => (process.env.TYPESAFE_API_BASE?.trim() || DEFAULT_BASE).replace(/\/+$/, '')

/** The key in use, the environment's first, and where it comes from; null without one. */
export function typesafeKey(): { key: string; source: TypesafeKeySource } | null {
  const envKey = process.env.TYPESAFE_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = getStoredTypesafeKey()
  return stored ? { key: stored, source: 'board' } : null
}

/** Checks a key with `GET /v1/models`; throws an HttpError when it is turned down or TypeSafe can't be reached. */
export async function verifyTypesafeKey(key: string) {
  let response: Response
  try {
    response = await fetch(`${typesafeBase()}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new HttpError(502, 'typesafe_error', `Could not reach TypeSafe: ${(error as Error).message}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(400, 'typesafe_error', 'TypeSafe turned down the key')
  }
  if (!response.ok) throw new HttpError(502, 'typesafe_error', `TypeSafe responded ${response.status}`)
}
