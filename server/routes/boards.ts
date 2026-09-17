import { Hono } from 'hono'
import {
  boardExportSchema,
  claimNextSchema,
  createBoardSchema,
  createColumnSchema,
  createTagSchema,
  createTicketSchema,
  listTicketsQuerySchema,
  updateBoardSchema,
} from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { actorOf, readJson } from '../http.ts'
import type { PullRequestSync } from '../pull-request-sync.ts'
import { createBoard, deleteBoard, getBoard, getBoardDetail, listBoards, updateBoard } from '../store/boards.ts'
import { createColumn } from '../store/columns.ts'
import { createTag } from '../store/tags.ts'
import { claimNextTicket, createTicket, getTicketByNumber, listTickets } from '../store/tickets.ts'
import { exportBoard, importBoard } from '../store/transfer.ts'

export const boardRoutes = (pullRequests: PullRequestSync) =>
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
    .get('/:boardId', (c) => c.json(getBoardDetail(c.req.param('boardId'))))
    .patch('/:boardId', async (c) => {
      const input = await readJson(c, updateBoardSchema)
      return c.json(transaction(() => updateBoard(c.req.param('boardId'), input)))
    })
    .delete('/:boardId', (c) => {
      transaction(() => deleteBoard(c.req.param('boardId')))
      return c.body(null, 204)
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
    .get('/:boardId/tickets', (c) => {
      const boardId = getBoard(c.req.param('boardId')).id
      const query = listTicketsQuerySchema.parse({
        column: c.req.query('column'),
        assignee: c.req.query('assignee'),
        unassigned: c.req.query('unassigned'),
        tag: c.req.queries('tag'),
        priority: c.req.queries('priority'),
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
    .post('/:boardId/tickets/claim-next', async (c) => {
      const input = await readJson(c, claimNextSchema)
      return c.json(transaction(() => claimNextTicket(c.req.param('boardId'), input)))
    })
