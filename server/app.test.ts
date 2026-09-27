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
  type MergePlan,
  type MergeRun,
  type Overview,
  type Ticket,
  type TokenUsage,
} from '../shared/domain.ts'
import { createApp } from './app.ts'
import { createAttachmentFiles } from './attachment-files.ts'
import { createMergeQueue } from './merge-queue.ts'
import { subscribe } from './events.ts'
import { type GitHubAuth, GitHubError, type GitHubPullRequest, type NewRepository } from './github.ts'
import { createPullRequestSync } from './pull-request-sync.ts'
import { getOverview } from './store/overview.ts'
import type { PullRequestStatus } from './store/tickets.ts'

/** Fake GitHub: pull requests are open unless a test says otherwise. */
const pullRequestStatuses = new Map<string, PullRequestStatus>()
/** Fake GitHub signed in as "octocat"; repositories it has created, as owner/name. */
const github = { auth: 'env' as GitHubAuth, repos: new Set<string>(), created: [] as NewRepository[] }
/** Fake GitHub pull requests for merging, by `owner/name#number`. */
const pulls = new Map<string, GitHubPullRequest & { files: string[] }>()
/** `head>base` pairs where `head` contains `base`'s commits. */
const containing = new Set<string>()
/** Called after the fake merges a pull request, to change the others the way GitHub would. */
let afterMerge: (key: string) => void = () => {}
const merges: string[] = []
const pull = (repo: string, number: number) => {
  const found = pulls.get(`${repo}#${number}`)
  if (!found) throw new Error(`GitHub responded 404 for ${repo}#${number}`)
  return found
}
const attachmentDir = mkdtempSync(join(tmpdir(), 'ultrakanban-attachments-'))
const pullRequests = createPullRequestSync({
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
  getPullRequest: async (repo, number) => ({ ...pull(repo, number) }),
  listPullRequestFiles: async (repo, number) => pull(repo, number).files,
  containsCommit: async (_repo, head, base) => containing.has(`${head}>${base}`),
  mergeMethods: async () => ['merge', 'squash'],
  async mergePullRequest(repo, number, { method, sha }) {
    const merging = pull(repo, number)
    if (merging.mergeable === false) throw new Error('GitHub responded 405: Pull Request is not mergeable')
    if (merging.headSha !== sha) throw new Error('GitHub responded 409: Head branch was modified')
    Object.assign(merging, { merged: true, state: 'closed' })
    pullRequestStatuses.set(`https://github.com/${repo}/pull/${number}`, { state: 'merged', title: merging.title })
    merges.push(`${repo}#${number}:${method}`)
    afterMerge(`${repo}#${number}`)
  },
  setPullRequestBase: async (repo, number, base) => void (pull(repo, number).base = base),
})
const app = createApp({
  attachmentFiles: createAttachmentFiles(attachmentDir),
  pullRequests,
  mergeQueue: createMergeQueue(pullRequests, { pollMs: 0 }),
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

describe('checklists', () => {
  const description = [
    'Steps:',
    '- [ ] reproduce',
    '```md',
    '- [ ] not a task, just code',
    '```',
    '  * [X] fix it',
    '- [ ] add a test',
  ].join('\n')

  test('lists the checklist items of the description', async () => {
    const ticket = await addTicket({ title: 'A', description })
    const { body } = await call('GET', `/tickets/${ticket.id}/checklist`)

    assert.deepEqual(body, [
      { index: 0, text: 'reproduce', checked: false },
      { index: 1, text: 'fix it', checked: true },
      { index: 2, text: 'add a test', checked: false },
    ])
  })

  test('agents check off one item without rewriting the description', async () => {
    const ticket = await addTicket({ title: 'A', description })
    const checked = await call<Ticket>('POST', `/tickets/${ticket.id}/checklist/2`, {}, 'alpha')
    const unchecked = await call<Ticket>('POST', `/tickets/${ticket.id}/checklist/1`, { checked: false }, 'alpha')
    const again = await call<Ticket>('POST', `/tickets/${ticket.id}/checklist/1`, { checked: false }, 'alpha')
    const { body: activity } = await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)

    assert.equal(checked.body.description, description.replace('- [ ] add a test', '- [x] add a test'))
    assert.equal(unchecked.body.description, checked.body.description.replace('  * [X] fix it', '  * [ ] fix it'))
    assert.equal(again.body.version, unchecked.body.version)
    assert.deepEqual(
      activity.filter((entry) => entry.type === 'checked').map(({ actor, data }) => ({ actor, data })),
      [
        { actor: 'alpha', data: { item: 'add a test', checked: true } },
        { actor: 'alpha', data: { item: 'fix it', checked: false } },
      ],
    )
  })

  test('rejects unknown items and stale versions', async () => {
    const ticket = await addTicket({ title: 'A', description })
    const missing = await call<ApiErrorBody>('POST', `/tickets/${ticket.id}/checklist/3`, {})
    const invalid = await call<ApiErrorBody>('POST', `/tickets/${ticket.id}/checklist/first`, {})
    const stale = await call<ApiErrorBody>('POST', `/tickets/${ticket.id}/checklist/0`, { ifVersion: 9 })

    assert.equal(missing.status, 404)
    assert.equal(invalid.status, 400)
    assert.equal(stale.body.error.code, 'version_conflict')
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
      github.auth = 'env'
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
    const other = await addTicket({ title: 'B' })
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
    const completion = done.completions.find((entry) => entry.ticketId === ticket.id)!
    assert.ok(completion.cycleMs !== null && completion.reviewMs !== null && completion.cycleMs >= completion.reviewMs)

    // Tickets moved to done without being worked or reviewed have no cycle or review time.
    await call('POST', `/tickets/${other.id}/move`, { column: 'Done', force: true })
    const { body: moved } = await call<Overview>('GET', '/overview')
    const skipped = moved.completions.find((entry) => entry.ticketId === other.id)!
    assert.deepEqual([skipped.cycleMs, skipped.reviewMs], [null, null])

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

  test('agents report the tokens their runs use, and the overview adds them up', async () => {
    const agent = 'token-agent'
    const ticket = await addTicket({ title: 'A' })
    const run = { agent, inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400 }
    const { status, body: recorded } = await call<TokenUsage>('POST', `/tickets/${ticket.id}/usage`, {
      ...run,
      costUsd: 0.25,
      durationMs: 60_000,
    })
    assert.equal(status, 201)
    assert.deepEqual([recorded.ticketId, recorded.costUsd, recorded.durationMs], [ticket.id, 0.25, 60_000])
    // Cache counts, cost and duration are optional.
    await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: 1, outputTokens: 2 })
    assert.equal(
      (await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: -1, outputTokens: 0 })).status,
      400,
    )
    assert.equal((await call('POST', '/tickets/nope/usage', run)).status, 404)

    const { body: listed } = await call<TokenUsage[]>('GET', `/tickets/${ticket.id}/usage`)
    assert.deepEqual(
      listed.map((entry) => [entry.inputTokens, entry.cacheReadTokens, entry.costUsd]),
      [
        [10, 3000, 0.25],
        [1, 0, null],
      ],
    )

    const { body: overview } = await call<Overview>('GET', '/overview')
    const usage = overview.agents.find((entry) => entry.name === agent)?.usage
    assert.deepEqual(usage, {
      inputTokens: 11,
      outputTokens: 202,
      cacheReadTokens: 3000,
      cacheWriteTokens: 400,
      costUsd: 0.25,
      runs: 2,
    })
    assert.equal(overview.boards.find((entry) => entry.id === boardId)?.tokens, 3613)
    assert.equal(overview.totals.usage.runs, overview.usage.length)
    assert.deepEqual(
      overview.usage.filter((entry) => entry.agent === agent).map((entry) => [entry.ticketId, entry.boardId]),
      [
        [ticket.id, boardId],
        [ticket.id, boardId],
      ],
    )
    // Runs from before the range don't count.
    assert.ok(
      !getOverview(7, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)).usage.some((entry) => entry.agent === agent),
    )
  })

  test('agents report runs that were not on a ticket to the board', async () => {
    const agent = 'board-token-agent'
    const ticket = await addTicket({ title: 'A' })
    const tokensBefore = (await call<Overview>('GET', '/overview')).body.boards.find(
      (entry) => entry.id === boardId,
    )?.tokens
    await call('POST', `/tickets/${ticket.id}/usage`, { agent, inputTokens: 1, outputTokens: 2 })
    const { status, body: recorded } = await call<TokenUsage>('POST', `/boards/${boardId}/usage`, {
      agent,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.5,
    })
    assert.equal(status, 201)
    assert.deepEqual([recorded.boardId, recorded.ticketId, recorded.costUsd], [boardId, null, 0.5])
    assert.equal(
      (await call('POST', `/boards/${boardId}/usage`, { agent, inputTokens: -1, outputTokens: 0 })).status,
      400,
    )
    assert.equal((await call('POST', '/boards/nope/usage', { agent, inputTokens: 1, outputTokens: 1 })).status, 404)

    // The board lists runs on its tickets and its own; the ticket only its runs.
    const { body: board } = await call<TokenUsage[]>('GET', `/boards/${boardId}/usage`)
    assert.deepEqual(
      board.filter((entry) => entry.agent === agent).map((entry) => entry.ticketId),
      [ticket.id, null],
    )
    const { body: onTicket } = await call<TokenUsage[]>('GET', `/tickets/${ticket.id}/usage`)
    assert.equal(onTicket.filter((entry) => entry.agent === agent).length, 1)

    const { body: overview } = await call<Overview>('GET', '/overview')
    const usage = overview.agents.find((entry) => entry.name === agent)?.usage
    assert.deepEqual([usage?.inputTokens, usage?.outputTokens, usage?.costUsd, usage?.runs], [11, 22, 0.5, 2])
    assert.equal(overview.boards.find((entry) => entry.id === boardId)?.tokens, (tokensBefore ?? 0) + 33)
    assert.deepEqual(
      overview.usage.filter((entry) => entry.agent === agent).map((entry) => [entry.ticketId, entry.boardId]),
      [
        [ticket.id, boardId],
        [null, boardId],
      ],
    )
  })

  test('overview hides cleared agents until they do something again', async () => {
    const agent = 'stale-agent'
    const ticket = await addTicket({ title: 'A' })
    await call('POST', `/tickets/${ticket.id}/claim`, { agent }, agent)
    const listed = async () => {
      const { body } = await call<Overview>('GET', '/overview')
      return [body.agents.some((entry) => entry.name === agent), body.hiddenAgents.includes(agent)]
    }
    assert.deepEqual(await listed(), [true, false])

    assert.equal((await call('POST', '/overview/hidden-agents', { names: [agent] })).status, 204)
    assert.deepEqual(await listed(), [false, true])
    assert.equal((await call('POST', '/overview/hidden-agents', { names: [] })).status, 400)

    await call('POST', `/tickets/${ticket.id}/comments`, { body: 'Still here' }, agent)
    assert.deepEqual(await listed(), [true, false])

    await call('POST', '/overview/hidden-agents', { names: [agent] })
    assert.equal((await call('DELETE', '/overview/hidden-agents')).status, 204)
    assert.deepEqual(await listed(), [true, false])
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

describe('merging all reviewed pull requests', () => {
  const REPO = 'acme/app'
  const url = (number: number) => `https://github.com/${REPO}/pull/${number}`

  /** Adds a ticket in review with an open pull request on the fake GitHub. */
  async function inReview(number: number, pullRequest: Partial<GitHubPullRequest> & { files?: string[] } = {}) {
    pulls.set(`${REPO}#${number}`, {
      state: 'open',
      merged: false,
      draft: false,
      title: `PR ${number}`,
      mergeable: true,
      mergeableState: 'clean',
      base: 'main',
      head: `branch-${number}`,
      headSha: `sha-${number}`,
      files: [`file-${number}.ts`],
      ...pullRequest,
    })
    const ticket = await addTicket({ title: `Ticket for ${number}`, column: 'Review', pullRequest: url(number) })
    return ticket.id
  }

  async function runToEnd(method = 'merge') {
    const started = await call<MergeRun>('POST', `/boards/${boardId}/merge-run`, { method })
    assert.equal(started.status, 202)
    for (;;) {
      const { body: run } = await call<MergeRun>('GET', `/boards/${boardId}/merge-run`)
      if (run.status === 'finished') return run
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Merging',
      columns: ['Todo', 'Review', 'Done'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
    })
    boardId = body.id
    for (const map of [pulls, pullRequestStatuses, containing]) map.clear()
    merges.length = 0
    afterMerge = () => {}
  })

  test('plans stacked pull requests after the ones they build on, otherwise in column order', async () => {
    const independent = await inReview(1, { files: ['shared.ts'] })
    const stacked = await inReview(2, { base: 'branch-3', files: ['b.ts', 'c.ts'] })
    const base = await inReview(3, { files: ['c.ts'] })
    const containsFirst = await inReview(4, { files: ['shared.ts', 'd.ts'] })
    const draft = await inReview(5, { draft: true })
    const blocked = await inReview(6, { mergeableState: 'blocked' })
    containing.add('sha-4>sha-1')
    await addTicket({ title: 'No pull request', column: 'Review' })

    const { body: plan } = await call<MergePlan>('GET', `/boards/${boardId}/merge-plan`)

    assert.deepEqual(
      plan.items.map((item) => item.number),
      [1, 3, 2, 4, 5, 6],
    )
    const byTicket = new Map(plan.items.map((item) => [item.ticketId, item]))
    assert.deepEqual(byTicket.get(stacked)?.after, [base])
    assert.deepEqual(byTicket.get(containsFirst)?.after, [independent])
    assert.deepEqual(byTicket.get(independent)?.overlaps, [containsFirst])
    assert.equal(byTicket.get(draft)?.skip, 'Still a draft')
    assert.equal(byTicket.get(blocked)?.skip, null)
    assert.match(byTicket.get(blocked)?.warning ?? '', /required reviews or checks/)
    assert.deepEqual(plan.methods, ['merge', 'squash'])
  })

  test('merges in order, retargets stacked pull requests and moves the tickets to done', async () => {
    const stacked = await inReview(1, { base: 'branch-2' })
    const base = await inReview(2)
    const draft = await inReview(3, { draft: true })

    const run = await runToEnd('squash')
    const done = (await ticketsIn('Done')).map((ticket) => ticket.id)

    assert.deepEqual(merges, ['acme/app#2:squash', 'acme/app#1:squash'])
    assert.equal(pull(REPO, 1).base, 'main')
    assert.deepEqual(
      run.steps.map((step) => [step.number, step.status]),
      [
        [2, 'merged'],
        [1, 'merged'],
        [3, 'skipped'],
      ],
    )
    assert.deepEqual(done.sort(), [base, stacked].sort())
    assert.equal((await ticketsIn('Review'))[0].id, draft)
  })

  test('skips pull requests that conflict after earlier merges, and the ones built on them', async () => {
    await inReview(1, { files: ['same.ts'] })
    const conflicting = await inReview(2, { files: ['same.ts'] })
    await inReview(3, { base: 'branch-2' })
    await inReview(4)
    afterMerge = (key) => {
      if (key === `${REPO}#1`) Object.assign(pull(REPO, 2), { mergeable: false, mergeableState: 'dirty' })
    }

    const run = await runToEnd()

    assert.deepEqual(merges, ['acme/app#1:merge', 'acme/app#4:merge'])
    assert.deepEqual(
      run.steps.map((step) => [step.number, step.status, step.message]),
      [
        [1, 'merged', null],
        [2, 'skipped', 'Has conflicts with main; its agent can resolve them'],
        [3, 'skipped', "Builds on #2, which wasn't merged"],
        [4, 'merged', null],
      ],
    )
    assert.equal((await ticketsIn('Review'))[0].id, conflicting)
  })

  test('runs one at a time per board and needs a review column', async () => {
    await inReview(1)
    const [first, second] = await Promise.all([
      call('POST', `/boards/${boardId}/merge-run`, { method: 'merge' }),
      call<{ error: { code: string } }>('POST', `/boards/${boardId}/merge-run`, { method: 'merge' }),
    ])
    const invalid = await call('POST', `/boards/${boardId}/merge-run`, { method: 'fast-forward' })
    await call('PATCH', `/boards/${boardId}`, { reviewColumn: null })
    const noReview = await call('GET', `/boards/${boardId}/merge-plan`)

    assert.equal(first.status, 202)
    assert.equal(second.status, 409)
    assert.equal(second.body.error.code, 'merge_in_progress')
    assert.equal(invalid.status, 400)
    assert.equal(noReview.status, 400)
  })

  test('merges one ticket on its own, moving it to done', async () => {
    const ticket = await inReview(1)
    await inReview(2)

    const merged = await call<Ticket>('POST', `/tickets/${ticket}/merge`, { method: 'squash' })
    const { body: run } = await call<MergeRun>('GET', `/boards/${boardId}/merge-run`)

    assert.equal(merged.status, 200)
    assert.equal(merged.body.pullRequest?.state, 'merged')
    assert.equal(merged.body.columnId, (await ticketsIn('Done'))[0].columnId)
    assert.deepEqual(merges, ['acme/app#1:squash'])
    assert.deepEqual(
      run.steps.map((step) => [step.number, step.status]),
      [[1, 'merged']],
    )
  })

  test('merging one ticket falls back to a method the repository allows', async () => {
    const ticket = await inReview(1)
    await call('POST', `/tickets/${ticket}/merge`, { method: 'rebase' })
    assert.deepEqual(merges, ['acme/app#1:merge'])
  })

  test('refuses to merge one ticket that builds on another, conflicts or is not in review', async () => {
    await inReview(1)
    const stacked = await inReview(2, { base: 'branch-1' })
    const conflicting = await inReview(3, { mergeable: false, mergeableState: 'dirty' })
    const elsewhere = await addTicket({ title: 'Not in review', column: 'Todo', pullRequest: url(4) })

    const refused = []
    for (const id of [stacked, conflicting, elsewhere.id]) {
      refused.push(await call<ApiErrorBody>('POST', `/tickets/${id}/merge`, {}))
    }

    assert.deepEqual(
      refused.map(({ status, body }) => [status, body.error.message]),
      [
        [409, 'Builds on the pull request of #1; merge that one first, or merge all'],
        [409, 'Has conflicts with main'],
        [400, 'Only tickets in the review column with an open pull request can be merged'],
      ],
    )
    assert.deepEqual(merges, [])
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
