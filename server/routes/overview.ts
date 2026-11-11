import { Hono } from 'hono'
import { hideAgentsSchema, overviewActivityQuerySchema, overviewQuerySchema } from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { readJson } from '../http.ts'
import { getOverview, getOverviewActivity, hideAgents, showHiddenAgents } from '../store/overview.ts'

export const overviewRoutes = new Hono()
  .get('/', (c) => {
    const { days } = overviewQuerySchema.parse({ days: c.req.query('days') })
    return c.json(getOverview(days))
  })
  .get('/activity', (c) => {
    const { days, board } = overviewActivityQuerySchema.parse({
      days: c.req.query('days'),
      board: c.req.query('board'),
    })
    return c.json(getOverviewActivity(days, board ?? null))
  })
  .post('/hidden-agents', async (c) => {
    const { names } = await readJson(c, hideAgentsSchema)
    transaction(() => hideAgents(names))
    return c.body(null, 204)
  })
  .delete('/hidden-agents', (c) => {
    showHiddenAgents()
    return c.body(null, 204)
  })
