import { Hono } from 'hono'
import {
  agentSuggestionQuerySchema,
  attachmentCleanupSchema,
  boardDetailQuerySchema,
  boardExportSchema,
  bulkTicketsSchema,
  claimNextSchema,
  createBoardSchema,
  createColumnSchema,
  createEpicSchema,
  createGitHubRepoSchema,
  createTagSchema,
  createTicketSchema,
  listTicketsQuerySchema,
  mergeRunSchema,
  recordUsageSchema,
  updateBoardSchema,
} from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { gitHubFailure, HttpError } from '../errors.ts'
import { wake } from '../events.ts'
import { actorOf, readJson } from '../http.ts'
import type { AppServices } from '../app.ts'
import { createBoard, deleteBoard, getBoard, getBoardDetail, listBoards, updateBoard } from '../store/boards.ts'
import { recordClaim } from '../store/agent-services.ts'
import { createColumn } from '../store/columns.ts'
import { listAttachmentIds } from '../store/attachments.ts'
import { boardDiskBreakdown, cleanUpAttachments, requestAgentCleanup } from '../store/disk-usage.ts'
import { createEpic, listEpics } from '../store/epics.ts'
import { createTag } from '../store/tags.ts'
import {
  bulkUpdateTickets,
  claimNextTicket,
  createTicket,
  getTicketByNumber,
  listTickets,
  requestConflictFixes,
} from '../store/tickets.ts'
import { suggestAgent } from '../store/suggestions.ts'
import { exportBoard, importBoard } from '../store/transfer.ts'
import { listBoardUsage, recordBoardUsage } from '../store/usage.ts'

export const boardRoutes = ({ pullRequests, mergeQueue, attachmentFiles }: AppServices) =>
  new Hono()
    .get('/', (c) => c.json(listBoards()))
    .post('/', async (c) => {
      const input = await readJson(c, createBoardSchema)
      return c.json(
        transaction(() => createBoard(input)),
        201,
      )
    })
    .post('/import', async (c) => {
      const data = await readJson(c, boardExportSchema)
      return c.json(
        transaction(() => importBoard(data, actorOf(c))),
        201,
      )
    })
    .get('/:boardId', (c) => {
      const query = boardDetailQuerySchema.parse({ archived: c.req.query('archived') })
      return c.json(getBoardDetail(c.req.param('boardId'), query))
    })
    .patch('/:boardId', async (c) => {
      const input = await readJson(c, updateBoardSchema)
      return c.json(transaction(() => updateBoard(c.req.param('boardId'), input)))
    })
    .delete('/:boardId', (c) => {
      transaction(() => deleteBoard(c.req.param('boardId')))
      return c.body(null, 204)
    })
    .post('/:boardId/github-repo', async (c) => {
      const boardId = getBoard(c.req.param('boardId')).id
      const input = await readJson(c, createGitHubRepoSchema)
      const { github } = pullRequests
      if (!(await github.auth())) {
        throw new HttpError(
          400,
          'github_unauthenticated',
          'Not signed in to GitHub. Add a GitHub token on the Setup page (/setup), or set GITHUB_TOKEN',
        )
      }
      const created = await github.createRepository(input).catch((error: unknown) => {
        throw gitHubFailure(error)
      })
      return c.json(
        transaction(() => updateBoard(boardId, { githubRepo: created.repo })),
        201,
      )
    })
    .get('/:boardId/export', (c) => c.json(exportBoard(c.req.param('boardId'))))
    .post('/:boardId/columns', async (c) => {
      const input = await readJson(c, createColumnSchema)
      return c.json(
        transaction(() => createColumn(c.req.param('boardId'), input)),
        201,
      )
    })
    .post('/:boardId/tags', async (c) => {
      const input = await readJson(c, createTagSchema)
      return c.json(
        transaction(() => createTag(c.req.param('boardId'), input)),
        201,
      )
    })
    .get('/:boardId/epics', (c) => c.json(listEpics(getBoard(c.req.param('boardId')).id)))
    .post('/:boardId/epics', async (c) => {
      const input = await readJson(c, createEpicSchema)
      return c.json(
        transaction(() => createEpic(c.req.param('boardId'), input)),
        201,
      )
    })
    .get('/:boardId/tickets', (c) => {
      const boardId = getBoard(c.req.param('boardId')).id
      const query = listTicketsQuerySchema.parse({
        column: c.req.query('column'),
        assignee: c.req.query('assignee'),
        unassigned: c.req.query('unassigned'),
        tag: c.req.queries('tag'),
        priority: c.req.queries('priority'),
        epic: c.req.query('epic'),
        q: c.req.query('q'),
      })
      return c.json(listTickets(boardId, query))
    })
    .get('/:boardId/tickets/:number{[0-9]+}', (c) =>
      c.json(getTicketByNumber(c.req.param('boardId'), Number(c.req.param('number')))),
    )
    .post('/:boardId/tickets', async (c) => {
      const input = await readJson(c, createTicketSchema)
      const ticket = transaction(() => createTicket(c.req.param('boardId'), input, actorOf(c)))
      pullRequests.checkSoon(ticket)
      return c.json(ticket, 201)
    })
    .post('/:boardId/tickets/bulk', async (c) => {
      const boardId = getBoard(c.req.param('boardId')).id
      const input = await readJson(c, bulkTicketsSchema)
      return c.json({ tickets: transaction(() => bulkUpdateTickets(boardId, input, actorOf(c))) })
    })
    .post('/:boardId/tickets/claim-next', async (c) => {
      const boardId = c.req.param('boardId')
      const input = await readJson(c, claimNextSchema)
      // Noted for the header's agents button: a loop whose claims fail runs, but never works a ticket.
      try {
        const ticket = transaction(() => claimNextTicket(boardId, input))
        transaction(() => recordClaim(boardId, null))
        return c.json(ticket)
      } catch (error) {
        const nothingToDo = error instanceof HttpError && error.code === 'no_ticket_available'
        transaction(() =>
          recordClaim(boardId, nothingToDo ? null : error instanceof Error ? error.message : String(error)),
        )
        throw error
      }
    })
    .post('/:boardId/fix-conflicts', (c) => {
      const boardId = getBoard(c.req.param('boardId')).id
      const tickets = transaction(() => requestConflictFixes(boardId, actorOf(c)))
      wake({ boardId })
      return c.json({ tickets })
    })
    .get('/:boardId/disk-usage', (c) => c.json(boardDiskBreakdown(c.req.param('boardId'))))
    .post('/:boardId/attachments/cleanup', async (c) => {
      const input = await readJson(c, attachmentCleanupSchema)
      const deleted = transaction(() => cleanUpAttachments(c.req.param('boardId'), input))
      if (deleted.count) await attachmentFiles.sweep(listAttachmentIds())
      return c.json(deleted)
    })
    .post('/:boardId/agent-cleanup', (c) => {
      const board = transaction(() => requestAgentCleanup(c.req.param('boardId')))
      wake({ boardId: board.id })
      return c.json(board)
    })
    .get('/:boardId/agent-suggestion', (c) => {
      const query = agentSuggestionQuerySchema.parse({
        title: c.req.query('title'),
        tag: c.req.queries('tag'),
        steps: c.req.query('steps'),
      })
      return c.json(suggestAgent(c.req.param('boardId'), query))
    })
    .get('/:boardId/usage', (c) => c.json(listBoardUsage(c.req.param('boardId'))))
    .post('/:boardId/usage', async (c) => {
      const input = await readJson(c, recordUsageSchema)
      return c.json(
        transaction(() => recordBoardUsage(c.req.param('boardId'), input)),
        201,
      )
    })
    .get('/:boardId/merge-plan', async (c) => c.json(await mergeQueue.plan(c.req.param('boardId'))))
    .get('/:boardId/merge-run', (c) => c.json(mergeQueue.latest(getBoard(c.req.param('boardId')).id)))
    .post('/:boardId/merge-run', async (c) => {
      const { method } = await readJson(c, mergeRunSchema)
      return c.json(await mergeQueue.start(c.req.param('boardId'), method, actorOf(c)), 202)
    })
