import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../../shared/domain.ts'
import {
  claimTicketSchema,
  commentSchema,
  mergeTicketSchema,
  moveTicketSchema,
  releaseTicketSchema,
  submitForReviewSchema,
  updateTicketSchema,
} from '../../shared/schemas.ts'
import type { AppServices } from '../app.ts'
import { attachmentFilename, detectAttachmentType } from '../attachment-files.ts'
import { newId, transaction } from '../db.ts'
import { badRequest, HttpError } from '../errors.ts'
import { actorOf, errorBody, readJson } from '../http.ts'
import { listActivity } from '../store/activity.ts'
import { createAttachment, listAttachments } from '../store/attachments.ts'
import {
  addComment,
  claimTicket,
  deleteTicket,
  getTicket,
  moveTicket,
  releaseTicket,
  submitForReview,
  updateTicket,
} from '../store/tickets.ts'

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
    .get('/:ticketId/activity', (c) => {
      const ticket = getTicket(c.req.param('ticketId'))
      return c.json(listActivity(ticket.id))
    })
    .post('/:ticketId/comments', async (c) => {
      const { body } = await readJson(c, commentSchema)
      return c.json(
        transaction(() => addComment(c.req.param('ticketId'), body, actorOf(c))),
        201,
      )
    })
