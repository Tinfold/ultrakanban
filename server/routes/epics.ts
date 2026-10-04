import { Hono } from 'hono'
import { updateEpicSchema } from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { readJson } from '../http.ts'
import { deleteEpic, getEpic, updateEpic } from '../store/epics.ts'

export const epicRoutes = new Hono()
  .get('/:epicId', (c) => c.json(getEpic(c.req.param('epicId'))))
  .patch('/:epicId', async (c) => {
    const input = await readJson(c, updateEpicSchema)
    return c.json(transaction(() => updateEpic(c.req.param('epicId'), input)))
  })
  .delete('/:epicId', (c) => {
    transaction(() => deleteEpic(c.req.param('epicId')))
    return c.body(null, 204)
  })
