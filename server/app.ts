import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { z } from 'zod'
import { HttpError } from './errors.ts'
import type { AttachmentFiles } from './attachment-files.ts'
import { errorBody } from './http.ts'
import type { MergeQueue } from './merge-queue.ts'
import type { PullRequestSync } from './pull-request-sync.ts'
import { attachmentRoutes } from './routes/attachments.ts'
import { listAttachmentIds } from './store/attachments.ts'
import { boardRoutes } from './routes/boards.ts'
import { columnRoutes } from './routes/columns.ts'
import { eventRoutes } from './routes/events.ts'
import { overviewRoutes } from './routes/overview.ts'
import { tagRoutes } from './routes/tags.ts'
import { ticketRoutes } from './routes/tickets.ts'

const apiDocs = readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8')

export interface AppServices {
  pullRequests: PullRequestSync
  mergeQueue: MergeQueue
  attachmentFiles: AttachmentFiles
}

export function createApp(services: AppServices) {
  const { pullRequests, attachmentFiles } = services
  const api = new Hono()
    // Deleting tickets, columns or boards cascades to attachment rows; remove their files afterwards.
    .use(async (c, next) => {
      await next()
      if (c.req.method === 'DELETE' && c.res.ok) void attachmentFiles.sweep(listAttachmentIds())
    })
    .get('/', (c) => c.text(apiDocs, 200, { 'Content-Type': 'text/markdown; charset=utf-8' }))
    .get('/github', async (c) => c.json({ auth: await pullRequests.github.auth() }))
    .route('/boards', boardRoutes(services))
    .route('/columns', columnRoutes)
    .route('/tags', tagRoutes)
    .route('/tickets', ticketRoutes(services))
    .route('/attachments', attachmentRoutes(attachmentFiles))
    .route('/events', eventRoutes)
    .route('/overview', overviewRoutes)
    .all('*', (c) => c.json(errorBody('not_found', `No route for ${c.req.method} ${c.req.path}`), 404))

  return new Hono().route('/api', api).onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(errorBody(error.code, error.message, error.details), error.status)
    }
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(({ path, message }) => ({ path: path.join('.'), message }))
      return c.json(errorBody('validation_error', 'Invalid request', issues), 400)
    }
    console.error(error)
    return c.json(errorBody('internal_error', 'Internal server error'), 500)
  })
}
