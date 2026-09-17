import type { Context } from 'hono'
import type { z } from 'zod'
import type { ApiErrorBody } from '../shared/domain.ts'
import { badRequest } from './errors.ts'

export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw badRequest('Request body must be valid JSON')
  }
  return schema.parse(body)
}

export const errorBody = (code: string, message: string, details?: unknown): ApiErrorBody => ({
  error: { code, message, details },
})

/** Who performed a request, for the activity log. Sent by clients as the `X-Actor` header. */
export const actorOf = (c: Context) => c.req.header('x-actor')?.trim() || 'anonymous'
