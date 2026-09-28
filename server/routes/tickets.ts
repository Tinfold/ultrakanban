import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, parsePullRequestUrl } from '../../shared/domain.ts'
import { parseChecklist } from '../../shared/checklist.ts'
import {
  checkItemSchema,
  claimTicketSchema,
  commentSchema,
  createSubticketSchema,
  heartbeatSchema,
  mergeTicketSchema,
  moveTicketSchema,
  recordUsageSchema,
  releaseTicketSchema,
  submitForReviewSchema,
  updateTicketSchema,
} from '../../shared/schemas.ts'
import type { AppServices } from '../app.ts'
import { attachmentFilename, detectAttachmentType } from '../attachment-files.ts'
import { newId, transaction } from '../db.ts'
import { badRequest, gitHubFailure, HttpError } from '../errors.ts'
import type { GitHubClient } from '../github.ts'
import { actorOf, errorBody, readJson } from '../http.ts'
import { listActivity } from '../store/activity.ts'
import { createAttachment, listAttachments } from '../store/attachments.ts'
import {
  addComment,
  checkItem,
  claimTicket,
  createTicket,
  deleteTicket,
  getTicket,
  listSubtickets,
  moveTicket,
  recordHeartbeat,
  endRun,
  releaseTicket,
  submitForReview,
  updateTicket,
} from '../store/tickets.ts'
import { listUsage, recordUsage } from '../store/usage.ts'

/** Posts the comment on the ticket's pull request; returns its URL. */
async function commentOnPullRequest(github: GitHubClient, ticketId: string, body: string) {
  const url = getTicket(ticketId).pullRequest?.url
  const pullRequest = url && parsePullRequestUrl(url)
  if (!pullRequest) throw badRequest('The ticket has no GitHub pull request to comment on')
  if (!(await github.auth())) {
    throw new HttpError(
      400,
      'github_unauthenticated',
      'Not signed in to GitHub. Set GITHUB_TOKEN or run gh auth login, then restart the server',
    )
  }
  try {
    return await github.commentOnPullRequest(pullRequest.repo, pullRequest.number, body)
  } catch (error) {
    throw gitHubFailure(error)
  }
}

const tooLargeMessage = `Attachments can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`

export const ticketRoutes = ({ pullRequests, mergeQueue, attachmentFiles }: AppServices) =>
  new Hono()
    .get('/:ticketId', (c) => c.json(getTicket(c.req.param('ticketId'))))
    .patch('/:ticketId', async (c) => {
      const input = await readJson(c, updateTicketSchema)
      const ticket = transaction(() => updateTicket(c.req.param('ticketId'), input, actorOf(c)))
      pullRequests.checkSoon(ticket)
      return c.json(ticket)
    })
    .get('/:ticketId/children', (c) => c.json(listSubtickets(c.req.param('ticketId'))))
    .post('/:ticketId/children', async (c) => {
      const input = await readJson(c, createSubticketSchema)
      const ticket = transaction(() => {
        const parent = getTicket(c.req.param('ticketId'))
        return createTicket(parent.boardId, { ...input, parent: parent.id }, actorOf(c))
      })
      pullRequests.checkSoon(ticket)
      return c.json(ticket, 201)
    })
    .get('/:ticketId/checklist', (c) => c.json(parseChecklist(getTicket(c.req.param('ticketId')).description)))
    .post('/:ticketId/checklist/:index', async (c) => {
      const index = Number(c.req.param('index'))
      if (!Number.isInteger(index) || index < 0) throw badRequest('Checklist item index must be a whole number, from 0')
      const input = await readJson(c, checkItemSchema)
      return c.json(transaction(() => checkItem(c.req.param('ticketId'), index, input, actorOf(c))))
    })
    .post('/:ticketId/review', async (c) => {
      const input = await readJson(c, submitForReviewSchema)
      const ticket = transaction(() => submitForReview(c.req.param('ticketId'), input))
      pullRequests.checkSoon(ticket)
      return c.json(ticket)
    })
    .post('/:ticketId/pull-request/sync', async (c) => c.json(await pullRequests.syncTicket(c.req.param('ticketId'))))
    .post('/:ticketId/merge', async (c) => {
      const { method } = await readJson(c, mergeTicketSchema)
      return c.json(await mergeQueue.mergeTicket(c.req.param('ticketId'), method, actorOf(c)))
    })
    .get('/:ticketId/attachments', (c) => c.json(listAttachments(c.req.param('ticketId'))))
    .post(
      '/:ticketId/attachments',
      // Multipart framing adds some overhead on top of the file itself.
      bodyLimit({
        maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024,
        onError: (c) => c.json(errorBody('payload_too_large', tooLargeMessage), 413),
      }),
      async (c) => {
        const ticketId = getTicket(c.req.param('ticketId')).id
        const { file } = await c.req.parseBody()
        if (!(file instanceof File)) {
          throw badRequest('Send the file as multipart/form-data in a field named "file"')
        }
        if (file.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'payload_too_large', tooLargeMessage)

        const bytes = new Uint8Array(await file.arrayBuffer())
        const contentType = detectAttachmentType(bytes)
        if (!contentType) {
          throw new HttpError(
            415,
            'unsupported_media_type',
            `Attachments must be one of: ${ATTACHMENT_TYPES.join(', ')}`,
          )
        }

        const id = newId()
        await attachmentFiles.write(id, bytes)
        try {
          const attachment = transaction(() =>
            createAttachment(
              ticketId,
              { id, filename: attachmentFilename(file.name, contentType), contentType, size: bytes.length },
              actorOf(c),
            ),
          )
          return c.json(attachment, 201)
        } catch (error) {
          await attachmentFiles.remove(id)
          throw error
        }
      },
    )
    .delete('/:ticketId', (c) => {
      transaction(() => deleteTicket(c.req.param('ticketId')))
      return c.body(null, 204)
    })
    .post('/:ticketId/move', async (c) => {
      const input = await readJson(c, moveTicketSchema)
      return c.json(transaction(() => moveTicket(c.req.param('ticketId'), input, actorOf(c))))
    })
    .post('/:ticketId/claim', async (c) => {
      const input = await readJson(c, claimTicketSchema)
      return c.json(transaction(() => claimTicket(c.req.param('ticketId'), input)))
    })
    .post('/:ticketId/release', async (c) => {
      const input = await readJson(c, releaseTicketSchema)
      return c.json(transaction(() => releaseTicket(c.req.param('ticketId'), input)))
    })
    .post('/:ticketId/heartbeat', async (c) => {
      // The body is optional: a heartbeat without one keeps the run's step.
      const input = (await c.req.text()) ? await readJson(c, heartbeatSchema) : {}
      recordHeartbeat(c.req.param('ticketId'), input)
      return c.body(null, 204)
    })
    .delete('/:ticketId/heartbeat', (c) => {
      endRun(c.req.param('ticketId'))
      return c.body(null, 204)
    })
    .get('/:ticketId/activity', (c) => {
      const ticket = getTicket(c.req.param('ticketId'))
      return c.json(listActivity(ticket.id))
    })
    .get('/:ticketId/usage', (c) => c.json(listUsage(c.req.param('ticketId'))))
    .post('/:ticketId/usage', async (c) => {
      const input = await readJson(c, recordUsageSchema)
      return c.json(
        transaction(() => recordUsage(c.req.param('ticketId'), input)),
        201,
      )
    })
    .post('/:ticketId/comments', async (c) => {
      const { body, pullRequest } = await readJson(c, commentSchema)
      const ticketId = c.req.param('ticketId')
      // Posted on the pull request first, so a comment GitHub turns down isn't left on the ticket alone.
      const pullRequestComment = pullRequest
        ? await commentOnPullRequest(pullRequests.github, ticketId, body)
        : undefined
      return c.json(
        transaction(() => addComment(ticketId, body, actorOf(c), pullRequestComment)),
        201,
      )
    })
