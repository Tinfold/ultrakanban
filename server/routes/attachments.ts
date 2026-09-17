import { Hono } from 'hono'
import type { AttachmentFiles } from '../attachment-files.ts'
import { transaction } from '../db.ts'
import { notFound } from '../errors.ts'
import { deleteAttachment, getAttachment } from '../store/attachments.ts'

export const attachmentRoutes = (files: AttachmentFiles) =>
  new Hono()
    .get('/:attachmentId', async (c) => {
      const attachment = getAttachment(c.req.param('attachmentId'))
      const contents = await files.open(attachment.id)
      if (!contents) throw notFound('Attachment file', attachment.id)
      return c.body(contents, 200, {
        'Content-Type': attachment.contentType,
        'Content-Length': String(attachment.size),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      })
    })
    .delete('/:attachmentId', (c) => {
      transaction(() => deleteAttachment(c.req.param('attachmentId')))
      return c.body(null, 204)
    })
