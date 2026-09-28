import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { subscribe, subscribeWake } from '../events.ts'

const KEEPALIVE_MS = 25_000

/**
 * Server-sent `change` events ({ boardId }) for every committed board change, and `wake` events ({ boardId }) asking a
 * board's idle agent loops to look for work now, optionally filtered by `?board=`.
 */
export const eventRoutes = new Hono().get('/', (c) => {
  const board = c.req.query('board')
  return streamSSE(c, async (stream) => {
    const send = (type: string) => (event: { boardId: string }) => {
      if (!board || event.boardId === board) void stream.writeSSE({ event: type, data: JSON.stringify(event) })
    }
    const unsubscribe = subscribe(send('change'))
    const unsubscribeWake = subscribeWake(send('wake'))
    stream.onAbort(() => {
      unsubscribe()
      unsubscribeWake()
    })
    while (!stream.aborted) {
      await stream.writeSSE({ event: 'ping', data: '' })
      await stream.sleep(KEEPALIVE_MS)
    }
  })
})
