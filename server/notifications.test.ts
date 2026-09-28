import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { type ApiErrorBody, type BoardDetail, type BoardSummary } from '../shared/domain.ts'
import { type Notification, sendNotification } from './notifications.ts'
import { addTicket, boardId, call, mergeQueue, notifications, pulls, useBoard } from './test-app.ts'

describe('notifications', () => {
  const TARGET = 'https://ntfy.sh/my-board'
  const REPO = 'acme/app'
  const sent = () => notifications.filter((notification) => notification.boardId === boardId)
  const kinds = () => sent().map(({ kind, ticketNumber }) => `${kind} #${ticketNumber}`)

  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Notifying',
      columns: ['Todo', 'Doing', 'Review', 'Done'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
      notifyUrl: TARGET,
    })
    useBoard(body.id)
  })

  test('the target is a board setting', async () => {
    const { body } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    assert.equal(body.board.notifyUrl, TARGET)
    const invalid = await call<ApiErrorBody>('PATCH', `/boards/${boardId}`, { notifyUrl: 'not a url' })
    assert.equal(invalid.status, 400)
    const cleared = await call<BoardSummary>('PATCH', `/boards/${boardId}`, { notifyUrl: null })
    assert.equal(cleared.body.notifyUrl, null)
  })

  test('an agent asking a question notifies once per comment', async () => {
    const ticket = await addTicket({ title: 'Dark mode' })
    await call('POST', `/tickets/${ticket.id}/claim`, { agent: 'claude/opus/high', moveTo: 'Doing' })
    // Other people's comments aren't questions.
    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Use the system setting' })
    assert.deepEqual(kinds(), [])

    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Which colors?' }, 'claude/opus/high')
    assert.deepEqual(kinds(), [`question #${ticket.number}`])
    const [question] = sent()
    assert.equal(question.target, TARGET)
    assert.equal(question.message, 'Which colors?')
    assert.equal(question.title, `#${ticket.number} needs an answer: Dark mode`)

    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'And fonts?' }, 'claude/opus/high')
    assert.equal(sent().length, 2)
  })

  test('a comment can ask for a person, e.g. when CI did not run', async () => {
    const ticket = await addTicket({ title: 'Fix CI' })
    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'CI ran out of minutes', notify: true }, 'claude')
    assert.deepEqual(kinds(), [`attention #${ticket.number}`])
    assert.equal(sent()[0].message, 'CI ran out of minutes')
  })

  test('a plan waiting for approval notifies', async () => {
    await call('PATCH', `/boards/${boardId}`, { approvalSize: 'L' })
    const ticket = await addTicket({ title: 'Rewrite the API' })
    await call('POST', `/tickets/${ticket.id}/claim`, { agent: 'a', moveTo: 'Doing' })
    await call('POST', `/tickets/${ticket.id}/plan`, { agent: 'a', estimate: 'M', plan: 'Small change' })
    assert.deepEqual(kinds(), [])

    await call('POST', `/tickets/${ticket.id}/plan`, { agent: 'a', estimate: 'L', plan: 'Split it up' })
    assert.deepEqual(kinds(), [`approval #${ticket.number}`])
    assert.equal(sent()[0].title, `#${ticket.number} waits for approval of its plan: Rewrite the API`)
    assert.equal(sent()[0].message, 'L: Split it up')
  })

  test('an answered question ticket notifies', async () => {
    const ticket = await addTicket({ title: 'Why?', tags: ['question'] })
    await call('POST', `/tickets/${ticket.id}/claim`, { agent: 'a', moveTo: 'Doing' })
    await call('POST', `/tickets/${ticket.id}/review`, { agent: 'a', comment: 'Because.' }, 'a')
    // Only the answer: the ticket is in review, so its agent isn't waiting on anyone.
    assert.deepEqual(kinds(), [`answer #${ticket.number}`])
  })

  test('a pull request ready to merge notifies once per commit, only on boards without auto-merge', async () => {
    const addPull = (number: number, headSha: string, ready = true) =>
      pulls.set(`${REPO}#${number}`, {
        state: 'open',
        merged: false,
        draft: false,
        title: `PR ${number}`,
        mergeable: ready,
        mergeableState: ready ? 'clean' : 'dirty',
        base: 'main',
        head: `branch-${number}`,
        headSha,
        files: [],
      })
    const inReview = (number: number) =>
      addTicket({
        title: `Ticket ${number}`,
        column: 'Review',
        pullRequest: `https://github.com/${REPO}/pull/${number}`,
      })
    addPull(81, 'a1')
    addPull(82, 'b1', false)
    const ready = await inReview(81)
    await inReview(82)

    assert.equal((await mergeQueue.notifyReady(boardId)).length, 1)
    assert.deepEqual(kinds(), [`ready #${ready.number}`])
    assert.equal(sent()[0].url, `https://github.com/${REPO}/pull/81`)
    // Not again for the same commit, even through the server's regular check.
    await mergeQueue.autoMergeAll()
    assert.equal(sent().length, 1)
    // A new commit that is ready again is worth another one.
    addPull(81, 'a2')
    await mergeQueue.autoMergeAll()
    assert.equal(sent().length, 2)

    // With auto-merge the server merges it itself instead.
    addPull(81, 'a3')
    await call('PATCH', `/boards/${boardId}`, { autoMerge: true })
    await mergeQueue.autoMergeAll()
    assert.equal(sent().length, 2)
  })

  test('boards without a target send nothing', async () => {
    await call('PATCH', `/boards/${boardId}`, { notifyUrl: null })
    const ticket = await addTicket({ title: 'Quiet' })
    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Look', notify: true })
    assert.deepEqual(kinds(), [])
  })
})

describe('sending a notification', () => {
  const notification: Notification = {
    kind: 'question',
    boardId: 'b',
    boardName: 'Board',
    ticketId: 't',
    ticketNumber: 7,
    ticketTitle: 'Dark mode 🌙',
    title: '#7 needs an answer: Dark mode 🌙',
    message: 'Which colors?',
    url: 'https://kanban.example/b/b?ticket=t',
  }

  /** Sends to `target` with a fake fetch, returning the request it made. */
  async function sendTo(target: string) {
    const real = globalThis.fetch
    let request: { url: string; body: string; contentType: string } | undefined
    globalThis.fetch = async (url, init) => {
      const headers = new Headers(init?.headers)
      request = { url: String(url), body: String(init?.body), contentType: headers.get('content-type')! }
      return new Response(null, { status: 200 })
    }
    try {
      await sendNotification(target, notification)
    } finally {
      globalThis.fetch = real
    }
    return request!
  }

  test('ntfy gets the message, with its title and link as query parameters', async () => {
    const request = await sendTo('https://ntfy.sh/topic')
    const url = new URL(request.url)
    assert.equal(url.searchParams.get('title'), notification.title)
    assert.equal(url.searchParams.get('click'), notification.url)
    assert.equal(request.body, 'Which colors?')
  })

  test('Discord gets a message', async () => {
    const request = await sendTo('https://discord.com/api/webhooks/1/abc')
    assert.deepEqual(JSON.parse(request.body), {
      content: `**${notification.title}**\nWhich colors?\n${notification.url}`,
    })
  })

  test('other webhooks get the notification as JSON', async () => {
    const request = await sendTo('https://hooks.example/notify')
    assert.equal(request.contentType, 'application/json')
    assert.deepEqual(JSON.parse(request.body), notification)
  })
})
