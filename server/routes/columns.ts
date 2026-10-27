import { Hono } from 'hono'
import { deleteColumnSchema, moveColumnSchema, releaseIdleSchema, updateColumnSchema } from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { HttpError } from '../errors.ts'
import { actorOf, readJson } from '../http.ts'
import { deleteColumn, getColumn, moveColumn, updateColumn } from '../store/columns.ts'
import { listIdleTickets, listTickets, moveAllTickets, releaseIdleTickets } from '../store/tickets.ts'

export const columnRoutes = new Hono()
  .patch('/:columnId', async (c) => {
    const input = await readJson(c, updateColumnSchema)
    return c.json(transaction(() => updateColumn(c.req.param('columnId'), input)))
  })
  .post('/:columnId/move', async (c) => {
    const { position } = await readJson(c, moveColumnSchema)
    return c.json(transaction(() => moveColumn(c.req.param('columnId'), position)))
  })
  .get('/:columnId/idle-tickets', (c) => c.json(listIdleTickets(c.req.param('columnId'))))
  .post('/:columnId/release-idle', async (c) => {
    const input = await readJson(c, releaseIdleSchema)
    return c.json(transaction(() => releaseIdleTickets(c.req.param('columnId'), input, actorOf(c))))
  })
  .delete('/:columnId', (c) => {
    const columnId = c.req.param('columnId')
    const { moveTicketsTo, deleteTickets } = deleteColumnSchema.parse({
      moveTicketsTo: c.req.query('moveTicketsTo'),
      deleteTickets: c.req.query('deleteTickets'),
    })
    transaction(() => {
      if (!moveTicketsTo && !deleteTickets && listTickets(getColumn(columnId).boardId, { column: columnId }).length) {
        throw new HttpError(
          409,
          'column_not_empty',
          'The column has tickets: pass moveTicketsTo to move them, or deleteTickets=true to delete them',
        )
      }
      if (moveTicketsTo) moveAllTickets(columnId, moveTicketsTo, actorOf(c))
      deleteColumn(columnId)
    })
    return c.body(null, 204)
  })
