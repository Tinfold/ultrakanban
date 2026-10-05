import { Hono } from 'hono'
import { reportAppUpdateSchema, reportClaudeUsageSchema } from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { actorOf, readJson } from '../http.ts'
import { cancelAppUpdate, getAppUpdate, reportAppUpdate, requestAppUpdate } from '../store/app-update.ts'
import { getClaudeUsage, reportClaudeUsage } from '../store/claude-usage.ts'

/**
 * What the agent supervisor does on the host: updating and restarting ultrakanban itself (see `AppUpdate`), and reading
 * how much Claude usage is left (see `ClaudeUsage`).
 */
export const systemRoutes = new Hono()
  .get('/update', (c) => c.json(getAppUpdate()))
  .post('/update', (c) =>
    c.json(
      transaction(() => requestAppUpdate(actorOf(c))),
      202,
    ),
  )
  .delete('/update', (c) => c.json(transaction(() => cancelAppUpdate())))
  .post('/update/status', async (c) => {
    const input = await readJson(c, reportAppUpdateSchema)
    return c.json(transaction(() => reportAppUpdate(input)))
  })
  .get('/claude-usage', (c) => c.json(getClaudeUsage()))
  .post('/claude-usage', async (c) => {
    const input = await readJson(c, reportClaudeUsageSchema)
    return c.json(transaction(() => reportClaudeUsage(input)))
  })
