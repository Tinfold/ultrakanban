import { Hono } from 'hono'
import { overviewQuerySchema } from '../../shared/schemas.ts'
import { getOverview } from '../store/overview.ts'

export const overviewRoutes = new Hono().get('/', (c) => {
  const { days } = overviewQuerySchema.parse({ days: c.req.query('days') })
  return c.json(getOverview(days))
})
