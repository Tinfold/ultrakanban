import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app.ts'
import { closeDatabase, databasePath } from './db.ts'
import { createAttachmentFiles } from './attachment-files.ts'
import { createGitHubClient } from './github.ts'
import { createMergeQueue } from './merge-queue.ts'
import { createNotifier } from './notifications.ts'
import { getStoredGitHubToken } from './store/setup.ts'
import { createPullRequestSync } from './pull-request-sync.ts'
import { listAttachmentIds } from './store/attachments.ts'

const port = Number(process.env.PORT ?? 4317)
const hostname = process.env.HOST ?? '127.0.0.1'
const clientDir = 'dist'
const syncIntervalMs = Number(process.env.GITHUB_SYNC_INTERVAL ?? 60) * 1000

const pullRequests = createPullRequestSync(createGitHubClient(getStoredGitHubToken))
const notifier = createNotifier()
const mergeQueue = createMergeQueue(pullRequests, { notifier })
/**
 * Attachment files live next to their database by default: the two belong together, and a stray
 * directory would be swept clean of files the database it belongs to doesn't know about.
 */
const attachmentsDirectory =
  process.env.ULTRAKANBAN_ATTACHMENTS ??
  (databasePath === ':memory:'
    ? mkdtempSync(join(tmpdir(), 'ultrakanban-'))
    : join(dirname(databasePath), 'attachments'))

const attachmentFiles = createAttachmentFiles(attachmentsDirectory)
const app = createApp({ pullRequests, mergeQueue, attachmentFiles, notifier })
pullRequests.start(syncIntervalMs)
mergeQueue.startAutoMerge(syncIntervalMs)
void attachmentFiles.sweep(listAttachmentIds())

// In development the app is served by Vite; serving a previous build here would run stale code.
const serveClient = process.env.NODE_ENV === 'production'

if (serveClient) {
  if (!existsSync(clientDir)) throw new Error(`No client build in ${clientDir}/; run "npm run build" first`)
  app.use('*', serveStatic({ root: clientDir }))
  app.get('*', serveStatic({ path: `${clientDir}/index.html` }))
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  const url = `http://${info.address}:${info.port}`
  console.log(serveClient ? `ultrakanban running at ${url}` : `ultrakanban API listening on ${url}/api`)
})

// Containers stop with SIGTERM; event streams would otherwise hold the process open until it is killed.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      closeDatabase()
      process.exit(0)
    })
    if ('closeAllConnections' in server) server.closeAllConnections()
  })
}
