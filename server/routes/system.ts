import { Hono } from 'hono'
import { reportAppUpdateSchema } from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { actorOf, readJson } from '../http.ts'
import { cancelAppUpdate, getAppUpdate, reportAppUpdate, requestAppUpdate } from '../store/app-update.ts'

/** Updating and restarting ultrakanban itself, which the agent supervisor does on the host (see `AppUpdate`). */
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
