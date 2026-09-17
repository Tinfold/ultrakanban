import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { subscribe } from '../events.ts'

const KEEPALIVE_MS = 25_000

/** Server-sent `change` events ({ boardId }) for every committed board change, optionally filtered by `?board=`. */
export const eventRoutes = new Hono().get('/', (c) => {
  const board = c.req.query('board')
  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((event) => {
      if (!board || event.boardId === board) void stream.writeSSE({ event: 'change', data: JSON.stringify(event) })
    })
    stream.onAbort(unsubscribe)
    while (!stream.aborted) {
      await stream.writeSSE({ event: 'ping', data: '' })
      await stream.sleep(KEEPALIVE_MS)
    }
  })
})
