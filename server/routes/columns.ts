import { Hono } from 'hono'
import { deleteColumnSchema, moveColumnSchema, updateColumnSchema } from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { actorOf, readJson } from '../http.ts'
import { deleteColumn, moveColumn, updateColumn } from '../store/columns.ts'
import { moveAllTickets } from '../store/tickets.ts'

export const columnRoutes = new Hono()
  .patch('/:columnId', async (c) => {
    const input = await readJson(c, updateColumnSchema)
    return c.json(transaction(() => updateColumn(c.req.param('columnId'), input)))
  })
  .post('/:columnId/move', async (c) => {
    const { position } = await readJson(c, moveColumnSchema)
    return c.json(transaction(() => moveColumn(c.req.param('columnId'), position)))
  })
  .delete('/:columnId', (c) => {
    const columnId = c.req.param('columnId')
    const { moveTicketsTo } = deleteColumnSchema.parse({ moveTicketsTo: c.req.query('moveTicketsTo') })
    transaction(() => {
      if (moveTicketsTo) moveAllTickets(columnId, moveTicketsTo, actorOf(c))
      deleteColumn(columnId)
    })
    return c.body(null, 204)
  })
