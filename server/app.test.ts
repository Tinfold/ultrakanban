import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import {
  type Activity,
  type ApiErrorBody,
  agentWorkerName,
  type Attachment,
  type BoardDetail,
  type BoardSummary,
  type Overview,
  type Ticket,
} from '../shared/domain.ts'
import { createApp } from './app.ts'
import { createAttachmentFiles } from './attachment-files.ts'
import { subscribe } from './events.ts'
import { type GitHubAuth, GitHubError, type NewRepository } from './github.ts'
import { createPullRequestSync } from './pull-request-sync.ts'
import { getOverview } from './store/overview.ts'
import type { PullRequestStatus } from './store/tickets.ts'

/** Fake GitHub: pull requests are open unless a test says otherwise. */
const pullRequestStatuses = new Map<string, PullRequestStatus>()
/** Fake GitHub signed in as "octocat"; repositories it has created, as owner/name. */
const github = { auth: null as GitHubAuth, repos: new Set<string>(), created: [] as NewRepository[] }
const attachmentDir = mkdtempSync(join(tmpdir(), 'ultrakanban-attachments-'))
const app = createApp({
  attachmentFiles: createAttachmentFiles(attachmentDir),
  pullRequests: createPullRequestSync({
    auth: async () => github.auth,
    fetchPullRequestStatus: async (url) => pullRequestStatuses.get(url) ?? { state: 'open', title: 'Some PR' },
    createRepository: async (input) => {
      const repo = `${input.owner ?? 'octocat'}/${input.name}`
      if (github.repos.has(repo)) {
        throw new GitHubError(422, 'Repository creation failed.: name already exists on this account')
      }
      github.repos.add(repo)
      github.created.push(input)
      return { repo, url: `https://github.com/${repo}` }
    },
  }),
})

async function call<T>(method: string, path: string, body?: unknown, actor = 'tester') {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}

let boardId: string

const ticketsIn = async (column: string) =>
  (await call<Ticket[]>('GET', `/boards/${boardId}/tickets?column=${encodeURIComponent(column)}`)).body

const addTicket = async (input: Record<string, unknown>) =>
  (await call<Ticket>('POST', `/boards/${boardId}/tickets`, input)).body

beforeEach(async () => {
  const { body } = await call<{ id: string }>('POST', '/boards', {
    name: 'Test',
    columns: ['Todo', 'Doing', 'Done'],
  })
  boardId = body.id
})

describe('tickets', () => {
  test('creates tickets with column/tag names and sequential numbers', async () => {
    const first = await addTicket({ title: 'One', column: 'doing', tags: ['bug', 'Bug', 'ui'], priority: 'high' })
    const second = await addTicket({ title: 'Two' })
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)

    assert.equal(first.number, 1)
    assert.equal(second.number, 2)
    assert.equal(first.columnId, board.columns[1].id)
    assert.equal(second.columnId, board.columns[0].id)
    assert.deepEqual(board.tags.map((tag) => tag.name).sort(), ['bug', 'ui'])
    assert.equal(first.tagIds.length, 2)
  })

  test('moves tickets to a position and reindexes siblings', async () => {
    const a = await addTicket({ title: 'A' })
    await addTicket({ title: 'B' })
    const c = await addTicket({ title: 'C', column: 'Doing' })

    await call('POST', `/tickets/${c.id}/move`, { column: 'Todo', position: 1 })
    assert.deepEqual(
      (await ticketsIn('Todo')).map((t) => t.title),
      ['A', 'C', 'B'],
    )

    await call('POST', `/tickets/${a.id}/move`, { column: 'Todo', position: 2 })
    assert.deepEqual(
      (await ticketsIn('Todo')).map((t) => t.title),
      ['C', 'B', 'A'],
    )
  })

  test('rejects stale writes with ifVersion', async () => {
    const ticket = await addTicket({ title: 'A' })
    const ok = await call<Ticket>('PATCH', `/tickets/${ticket.id}`, { title: 'B', ifVersion: 1 })
    const stale = await call<{ error: { code: string } }>('PATCH', `/tickets/${ticket.id}`, {
      title: 'C',
      ifVersion: 1,
    })

    assert.equal(ok.body.version, 2)
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'version_conflict')
  })

  test('validates input', async () => {
    const res = await call<{ error: { code: string } }>('POST', `/boards/${boardId}/tickets`, { priority: 'meh' })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'validation_error')
  })
})

describe('agent claiming', () => {
  test('claim is exclusive until released', async () => {
    const ticket = await addTicket({ title: 'Work' })

    const claimed = await call<Ticket>('POST', `/tickets/${ticket.id}/claim`, { agent: 'alpha', moveTo: 'Doing' })
    const again = await call<Ticket>('POST', `/tickets/${ticket.id}/claim`, { agent: 'alpha' })
    const stolen = await call<{ error: { code: string } }>('POST', `/tickets/${ticket.id}/claim`, { agent: 'beta' })
    const badRelease = await call('POST', `/tickets/${ticket.id}/release`, { agent: 'beta' })
    const released = await call<Ticket>('POST', `/tickets/${ticket.id}/release`, { agent: 'alpha' })
    const reclaimed = await call<Ticket>('POST', `/tickets/${ticket.id}/claim`, { agent: 'beta' })

    assert.equal(claimed.body.assignee, 'alpha')
    assert.equal((await ticketsIn('Doing'))[0].id, ticket.id)
    assert.equal(again.status, 200)
    assert.equal(stolen.status, 409)
    assert.equal(stolen.body.error.code, 'already_claimed')
    assert.equal(badRelease.status, 409)
    assert.equal(released.body.assignee, null)
    assert.equal(reclaimed.body.assignee, 'beta')
  })

  test('claim-next picks by priority, then due date, and never double-assigns', async () => {
    await addTicket({ title: 'low', priority: 'low' })
    await addTicket({ title: 'urgent-late', priority: 'urgent', dueDate: '2030-01-02' })
    await addTicket({ title: 'urgent-soon', priority: 'urgent', dueDate: '2030-01-01' })
    await addTicket({ title: 'tagged', priority: 'medium', tags: ['backend'] })

    const claims = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((agent) =>
        call<Ticket>('POST', `/boards/${boardId}/tickets/claim-next`, { agent, column: 'Todo' }),
      ),
    )
    const titles = claims.filter((res) => res.status === 200).map((res) => res.body.title)

    assert.deepEqual(titles, ['urgent-soon', 'urgent-late', 'tagged', 'low'])
    assert.equal(claims[4].status, 404)
  })

  test('claim-next filters by tag', async () => {
    await addTicket({ title: 'frontend', priority: 'urgent', tags: ['frontend'] })
    await addTicket({ title: 'backend', tags: ['backend'] })

    const res = await call<Ticket>('POST', `/boards/${boardId}/tickets/claim-next`, {
      agent: 'a',
      column: 'Todo',
      tags: ['backend'],
    })
    assert.equal(res.body.title, 'backend')
  })

  test('records activity', async () => {
    const ticket = await addTicket({ title: 'A' })
    await call('POST', `/tickets/${ticket.id}/claim`, { agent: 'alpha', moveTo: 'Done' })
    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Finished' }, 'alpha')
    const { body } = await call<{ type: string }[]>('GET', `/tickets/${ticket.id}/activity`)

    assert.deepEqual(
      body.map((entry) => entry.type),
      ['created', 'claimed', 'moved', 'comment'],
    )
  })
})

describe('boards', () => {
  test('deleting a column can move its tickets elsewhere', async () => {
    await addTicket({ title: 'A', column: 'Doing' })
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)

    const res = await call('DELETE', `/columns/${board.columns[1].id}?moveTicketsTo=Done`)
    const { body: after } = await call<BoardDetail>('GET', `/boards/${boardId}`)

    assert.equal(res.status, 204)
    assert.deepEqual(
      after.columns.map((column) => [column.name, column.position]),
      [
        ['Todo', 0],
        ['Done', 1],
      ],
    )
    assert.equal(after.tickets[0].columnId, after.columns[1].id)
  })

  test('export/import round-trips a board', async () => {
    const ticket = await addTicket({ title: 'A', column: 'Done', tags: ['x'], priority: 'high', agentEffort: 'low' })
    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'hello' })
    const { body: exported } = await call('GET', `/boards/${boardId}/export`)

    const { body: imported } = await call<{ id: string }>('POST', '/boards/import', exported)
    const { body: reexported } = await call('GET', `/boards/${imported.id}/export`)

    assert.deepEqual(reexported, exported)
  })

  test('publishes change events only after commit', async () => {
    const events: string[] = []
    const unsubscribe = subscribe((event) => events.push(event.boardId))
    await addTicket({ title: 'A' })
    await call('POST', `/boards/${boardId}/tickets`, { title: 'B', column: 'missing' })
    unsubscribe()

    assert.deepEqual(events, [boardId])
  })
})

describe('pull request workflow', () => {
  const PR = 'https://github.com/acme/app/pull/42'

  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Workflow',
      columns: ['Todo', 'In progress', 'Review', 'Done'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
    })
    boardId = body.id
  })

  test('done requires a merged pull request unless forced', async () => {
    const ticket = await addTicket({ title: 'A' })

    const blocked = await call<{ error: { code: string } }>('POST', `/tickets/${ticket.id}/move`, { column: 'Done' })
    const claimBlocked = await call('POST', `/tickets/${ticket.id}/claim`, { agent: 'a', moveTo: 'Done' })
    const createBlocked = await call('POST', `/boards/${boardId}/tickets`, { title: 'B', column: 'Done' })
    const forced = await call<Ticket>('POST', `/tickets/${ticket.id}/move`, { column: 'Done', force: true })

    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'pull_request_not_merged')
    assert.equal(claimBlocked.status, 409)
    assert.equal(createBlocked.status, 409)
    assert.equal(forced.status, 200)
  })

  test('agents submit for review, and merging moves the ticket to done', async () => {
    const ticket = await addTicket({ title: 'A' })
    await call('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'a', column: 'Todo', moveTo: 'In progress' })

    const stolen = await call('POST', `/tickets/${ticket.id}/review`, { agent: 'b', pullRequest: PR })
    const invalid = await call('POST', `/tickets/${ticket.id}/review`, { agent: 'a', pullRequest: 'https://x.dev/1' })
    const review = await call<Ticket>('POST', `/tickets/${ticket.id}/review`, {
      agent: 'a',
      pullRequest: `${PR}/files`,
      comment: 'Added the thing. Screenshots are in the PR.',
    })
    assert.equal(stolen.status, 409)
    assert.equal(invalid.status, 400)
    assert.equal((await ticketsIn('Review'))[0].id, ticket.id)
    assert.deepEqual(
      {
        url: review.body.pullRequest?.url,
        repo: review.body.pullRequest?.repo,
        number: review.body.pullRequest?.number,
      },
      { url: PR, repo: 'acme/app', number: 42 },
    )

    const open = await call<Ticket>('POST', `/tickets/${ticket.id}/pull-request/sync`)
    assert.equal(open.body.pullRequest?.state, 'open')
    assert.equal((await ticketsIn('Review'))[0].id, ticket.id)

    pullRequestStatuses.set(PR, { state: 'merged', title: 'Some PR' })
    const merged = await call<Ticket>('POST', `/tickets/${ticket.id}/pull-request/sync`)
    const { body: activity } = await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)

    assert.equal(merged.body.pullRequest?.state, 'merged')
    assert.equal((await ticketsIn('Done'))[0].id, ticket.id)
    assert.deepEqual(
      activity.map((entry) => [entry.actor, entry.type === 'pull_request' ? entry.data.event : entry.type]),
      [
        ['tester', 'created'],
        ['a', 'claimed'],
        ['a', 'moved'],
        ['a', 'linked'],
        ['a', 'moved'],
        ['a', 'comment'],
        ['github', 'merged'],
        ['github', 'moved'],
      ],
    )
    pullRequestStatuses.clear()
  })

  test('board agent settings', async () => {
    const {
      body: { board: initial },
    } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    assert.deepEqual(
      [initial.githubRepo, initial.agentEnabled, initial.agentName, initial.agentModel, initial.agentEffort],
      [null, false, null, null, null],
    )
    assert.equal(agentWorkerName(initial), 'claude/opus/high')

    const off = await call('PATCH', `/boards/${boardId}`, { agentEnabled: true })
    assert.equal(off.status, 400, 'the agent needs a repository')
    assert.equal((await call('PATCH', `/boards/${boardId}`, { githubRepo: 'not a repo' })).status, 400)
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentName: 'has space' })).status, 400)
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentName: 'claude/opus' })).status, 400)
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentModel: 'opus/high' })).status, 400)
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentEffort: 'extreme' })).status, 400)

    const { body: on } = await call<BoardSummary>('PATCH', `/boards/${boardId}`, {
      githubRepo: 'acme/app',
      agentEnabled: true,
      agentName: 'claude-2',
      agentModel: 'claude-sonnet-5',
      agentEffort: 'xhigh',
    })
    assert.deepEqual([on.githubRepo, on.agentEnabled, on.agentName], ['acme/app', true, 'claude-2'])
    assert.equal(agentWorkerName(on), 'claude-2/claude-sonnet-5/xhigh')
    const { body: boards } = await call<BoardSummary[]>('GET', '/boards')
    assert.ok(boards.some((board) => board.id === boardId && board.agentEnabled))

    const { body: cleared } = await call<BoardSummary>('PATCH', `/boards/${boardId}`, {
      agentEnabled: false,
      githubRepo: null,
      agentName: null,
      agentModel: null,
      agentEffort: null,
    })
    assert.deepEqual(
      [cleared.githubRepo, cleared.agentEnabled, cleared.agentName, cleared.agentModel, cleared.agentEffort],
      [null, false, null, null, null],
    )
  })

  test('creates a GitHub repository and links it to the board', async () => {
    const create = (body: unknown) => call<BoardSummary & ApiErrorBody>('POST', `/boards/${boardId}/github-repo`, body)

    github.auth = null
    const signedOut = await create({ name: 'app' })
    assert.equal(signedOut.status, 400)
    assert.equal(signedOut.body.error.code, 'github_unauthenticated')

    github.auth = 'gh'
    try {
      assert.equal((await create({ name: 'has space' })).status, 400)
      assert.equal((await create({ name: 'app', owner: 'not/an-owner' })).status, 400)
      assert.equal((await call('POST', '/boards/missing/github-repo', { name: 'app' })).status, 404)

      const mine = await create({ name: 'app', description: 'The app' })
      assert.equal(mine.status, 201)
      assert.equal(mine.body.githubRepo, 'octocat/app')
      assert.deepEqual(github.created.at(-1), { name: 'app', description: 'The app', private: true })

      const taken = await create({ name: 'app' })
      assert.equal(taken.status, 400)
      assert.equal(taken.body.error.code, 'github_error')
      assert.match(taken.body.error.message, /already exists/)

      const org = await create({ owner: 'acme', name: 'site', private: false })
      assert.equal(org.body.githubRepo, 'acme/site')
      assert.equal(github.created.at(-1)?.private, false)
      const { body: detail } = await call<BoardDetail>('GET', `/boards/${boardId}`)
      assert.equal(detail.board.githubRepo, 'acme/site')
    } finally {
      github.auth = null
    }
  })

  test('tickets can set the effort the agent works them at', async () => {
    const ticket = await addTicket({ title: 'Hard', agentEffort: 'max' })
    assert.equal(ticket.agentEffort, 'max')
    assert.equal((await addTicket({ title: 'Plain' })).agentEffort, null, 'null follows the board')
    assert.equal((await call('PATCH', `/tickets/${ticket.id}`, { agentEffort: 'extreme' })).status, 400)

    const { body: cleared } = await call<Ticket>('PATCH', `/tickets/${ticket.id}`, { agentEffort: null })
    assert.equal(cleared.agentEffort, null)
    assert.equal(cleared.version, ticket.version + 1)
    const activity = (await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)).body
    assert.ok(activity.some((entry) => entry.type === 'updated' && entry.data.fields.includes('agentEffort')))
  })

  test('review needs a configured review column', async () => {
    await call('PATCH', `/boards/${boardId}`, { reviewColumn: null })
    const ticket = await addTicket({ title: 'A' })
    const res = await call('POST', `/tickets/${ticket.id}/review`, { agent: 'a', pullRequest: PR })
    assert.equal(res.status, 400)
  })

  test('export/import keeps the workflow and pull requests', async () => {
    const ticket = await addTicket({ title: 'A', pullRequest: PR })
    await call('POST', `/tickets/${ticket.id}/pull-request/sync`)
    const { body: exported } = await call('GET', `/boards/${boardId}/export`)
    const { body: imported } = await call<{ id: string; doneColumnId: string }>('POST', '/boards/import', exported)
    const { body: reexported } = await call('GET', `/boards/${imported.id}/export`)

    assert.deepEqual(reexported, exported)
    assert.ok(imported.doneColumnId)
  })

  test('overview shows who works on what, for how long, and what got done', async () => {
    const agent = 'overview-agent'
    const ticket = await addTicket({ title: 'A' })
    await addTicket({ title: 'B' })
    await call('POST', `/boards/${boardId}/tickets/claim-next`, { agent, column: 'Todo', moveTo: 'In progress' })

    const { body: working } = await call<Overview>('GET', '/overview?days=7')
    const agentOf = (overview: Overview) => overview.agents.find((entry) => entry.name === agent)!
    const boardOf = (overview: Overview) => overview.boards.find((entry) => entry.id === boardId)!
    assert.equal(working.days, 7)
    assert.equal(agentOf(working).status, 'working')
    assert.deepEqual(
      agentOf(working).tickets.map((held) => [held.id, held.column, held.state]),
      [[ticket.id, 'In progress', 'working']],
    )
    assert.deepEqual([boardOf(working).open, boardOf(working).working, boardOf(working).review], [2, 1, 0])
    assert.equal(working.recent[0].ticket.boardId, boardId)

    // Ongoing work counts up to the time of the overview.
    const hourLater = getOverview(7, new Date(Date.now() + 60 * 60 * 1000))
    assert.ok(Math.abs(agentOf(hourLater).workedMs - 60 * 60 * 1000) < 60 * 1000)

    await call('POST', `/tickets/${ticket.id}/review`, { agent, pullRequest: PR })
    const { body: inReview } = await call<Overview>('GET', '/overview')
    assert.equal(inReview.days, 14)
    assert.equal(agentOf(inReview).status, 'review')
    assert.deepEqual(
      inReview.sessions.filter((session) => session.agent === agent).map((session) => session.end !== null),
      [true],
    )

    pullRequestStatuses.set(PR, { state: 'merged', title: 'Some PR' })
    await call('POST', `/tickets/${ticket.id}/pull-request/sync`)
    pullRequestStatuses.clear()
    const { body: done } = await call<Overview>('GET', '/overview')
    assert.deepEqual([agentOf(done).status, agentOf(done).tickets.length, agentOf(done).completed], ['idle', 0, 1])
    assert.deepEqual([boardOf(done).open, boardOf(done).completed], [1, 1])
    assert.ok(done.events.some((event) => event.boardId === boardId && event.kind === 'completed'))

    assert.equal((await call('GET', '/overview?days=3')).status, 400)
  })

  test('overview drops tickets whose pull request was closed or that were cancelled', async () => {
    const agent = 'closing-agent'
    await call('POST', `/boards/${boardId}/columns`, { name: 'Cancelled' })
    const closed = await addTicket({ title: 'Closed' })
    const cancelled = await addTicket({ title: 'Cancelled', column: 'In progress' })
    await call('POST', `/tickets/${closed.id}/claim`, { agent, moveTo: 'In progress' })
    await call('POST', `/tickets/${cancelled.id}/claim`, { agent })
    await call('POST', `/tickets/${closed.id}/review`, { agent, pullRequest: PR })
    pullRequestStatuses.set(PR, { state: 'closed', title: 'Some PR' })
    await call('POST', `/tickets/${closed.id}/pull-request/sync`)
    pullRequestStatuses.clear()
    await call('POST', `/tickets/${cancelled.id}/move`, { column: 'Cancelled' })

    const { body: overview } = await call<Overview>('GET', '/overview')
    const held = overview.agents.find((entry) => entry.name === agent)!
    const board = overview.boards.find((entry) => entry.id === boardId)!
    assert.deepEqual([held.status, held.tickets.length], ['idle', 0])
    assert.deepEqual([board.open, board.working, board.review], [0, 0, 0])
    assert.ok(overview.sessions.filter((session) => session.agent === agent).every((session) => session.end !== null))
  })

  test('overview lists enabled board agents under their worker names', async () => {
    await call('PATCH', `/boards/${boardId}`, { githubRepo: 'acme/app', agentEnabled: true, agentName: 'idle-agent' })
    const { body: idle } = await call<Overview>('GET', '/overview')
    const agent = idle.agents.find((entry) => entry.name === 'idle-agent/opus/high')
    assert.deepEqual([agent?.status, agent?.agentOf], ['idle', [boardId]])
    assert.ok(!idle.agents.some((entry) => entry.name === 'idle-agent' || entry.name === 'idle-agent/opus/max'))

    // A ticket's own effort runs under its own worker name, which still counts as the board's host agent.
    await addTicket({ title: 'A' })
    await call('POST', `/boards/${boardId}/tickets/claim-next`, { agent: 'idle-agent/opus/max', column: 'Todo' })
    const { body: working } = await call<Overview>('GET', '/overview')
    const variant = working.agents.find((entry) => entry.name === 'idle-agent/opus/max')
    assert.deepEqual([variant?.status, variant?.agentOf], ['working', [boardId]])
    await call('PATCH', `/boards/${boardId}`, { agentEnabled: false })
  })

  test('deleting a column clears it from the workflow', async () => {
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    await call('DELETE', `/columns/${board.board.doneColumnId}`)
    const { body: after } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    const deleted = await call('DELETE', `/boards/${boardId}`)

    assert.equal(after.board.doneColumnId, null)
    assert.equal(deleted.status, 204)
  })
})

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
