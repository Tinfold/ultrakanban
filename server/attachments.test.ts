import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import {
  type Activity,
  type Attachment,
  type AttachmentCleanup,
  type BoardDiskBreakdown,
  type BoardSummary,
  type Ticket,
} from '../shared/domain.ts'
import { sql } from './db.ts'
import { addTicket, app, attachmentDir, boardId, call } from './test-app.ts'

describe('attachments', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

  const upload = async (ticketId: string, bytes: Uint8Array, filename: string, type = 'image/png') => {
    const form = new FormData()
    form.append('file', new File([bytes], filename, { type }))
    const res = await app.request(`/api/tickets/${ticketId}/attachments`, {
      method: 'POST',
      headers: { 'x-actor': 'agent-1' },
      body: form,
    })
    return { status: res.status, body: (await res.json()) as Attachment & { error: { code: string } } }
  }

  test('uploads, serves and lists screenshots', async () => {
    const ticket = await addTicket({ title: 'A' })
    const { status, body: attachment } = await upload(ticket.id, PNG, '../../screenshot.png')

    const served = await app.request(attachment.url)
    const { body: listed } = await call<Attachment[]>('GET', `/tickets/${ticket.id}/attachments`)
    const { body: activity } = await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)
    const { body: updated } = await call<Ticket>('GET', `/tickets/${ticket.id}`)

    assert.equal(status, 201)
    assert.equal(attachment.filename, 'screenshot.png')
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG)
    assert.deepEqual(
      listed.map((item) => item.id),
      [attachment.id],
    )
    assert.equal(activity.at(-1)?.type, 'attachment')
    assert.equal(updated.attachmentCount, 1)
  })

  test('rejects unsupported files regardless of declared type', async () => {
    const ticket = await addTicket({ title: 'A' })
    const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>')
    const res = await upload(ticket.id, svg, 'fake.png', 'image/png')
    const missing = await call('POST', `/tickets/${ticket.id}/attachments`, {})

    assert.equal(res.status, 415)
    assert.equal(res.body.error.code, 'unsupported_media_type')
    assert.equal(missing.status, 400)
  })

  test('removes files when the attachment or its ticket is deleted', async () => {
    const ticket = await addTicket({ title: 'A' })
    const first = (await upload(ticket.id, PNG, 'one.png')).body
    const second = (await upload(ticket.id, PNG, 'two.png')).body

    await call('DELETE', `/attachments/${first.id}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(!readdirSync(attachmentDir).includes(first.id))
    assert.ok(readdirSync(attachmentDir).includes(second.id))

    await call('DELETE', `/tickets/${ticket.id}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(!readdirSync(attachmentDir).includes(second.id))
    assert.equal((await app.request(second.url)).status, 404)
  })

  test('breaks down disk usage and deletes the attachments of finished tickets', async () => {
    const MP4 = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypmp42'), 1, 2, 3, 4, 5, 6, 7, 8])
    await call('POST', `/boards/${boardId}/columns`, { name: 'Cancelled' })
    const open = await addTicket({ title: 'Open' })
    const cancelled = await addTicket({ title: 'Cancelled' })
    const kept = (await upload(open.id, PNG, 'open.png')).body
    const recent = (await upload(cancelled.id, MP4, 'recording.mp4')).body
    const old = (await upload(cancelled.id, PNG, 'old.png')).body
    await call('POST', `/tickets/${cancelled.id}/move`, { column: 'Cancelled' })
    sql.run('UPDATE attachments SET created_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', old.id)

    const { body: usage } = await call<BoardDiskBreakdown>('GET', `/boards/${boardId}/disk-usage`)
    assert.deepEqual(usage.attachments.images, { count: 2, bytes: PNG.length * 2 })
    assert.deepEqual(usage.attachments.videos, { count: 1, bytes: MP4.length })
    assert.deepEqual(usage.attachments.finished, { count: 2, bytes: PNG.length + MP4.length })
    assert.deepEqual(
      usage.attachments.tickets.map(({ title, count, finished }) => ({ title, count, finished })),
      [
        { title: 'Cancelled', count: 2, finished: true },
        { title: 'Open', count: 1, finished: false },
      ],
    )
    assert.equal(usage.agent, null)

    const path = `/boards/${boardId}/attachments/cleanup`
    const { body: aged } = await call<AttachmentCleanup>('POST', path, { olderThanDays: 30 })
    assert.deepEqual(aged, { count: 1, bytes: PNG.length })
    const { body: rest } = await call<AttachmentCleanup>('POST', path, {})
    assert.deepEqual(rest, { count: 1, bytes: MP4.length })
    const { body: none } = await call<AttachmentCleanup>('POST', path, {})
    assert.deepEqual(none, { count: 0, bytes: 0 })

    const files = readdirSync(attachmentDir)
    assert.ok(files.includes(kept.id))
    assert.ok(!files.includes(old.id) && !files.includes(recent.id))
    assert.equal((await call('POST', path, { olderThanDays: 0 })).status, 400)
  })

  test('asks the board agent to clear its build output', async () => {
    const { status, body } = await call<BoardSummary>('POST', `/boards/${boardId}/agent-cleanup`)
    const { body: board } = await call<{ board: BoardSummary }>('GET', `/boards/${boardId}`)

    assert.equal(status, 200)
    assert.ok(body.agentCleanupRequestedAt)
    assert.equal(board.board.agentCleanupRequestedAt, body.agentCleanupRequestedAt)
  })
})
