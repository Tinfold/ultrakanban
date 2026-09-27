import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import { type Activity, type Attachment, type Ticket } from '../shared/domain.ts'
import { addTicket, app, attachmentDir, call } from './test-app.ts'

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
})
