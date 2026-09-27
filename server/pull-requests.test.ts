import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import {
  type Activity,
  type ApiErrorBody,
  AGENT_MAX_CONCURRENCY,
  agentWorkerName,
  type BoardDetail,
  type BoardSummary,
  type Ticket,
} from '../shared/domain.ts'
import { addTicket, boardId, call, github, pullRequestStatuses, ticketsIn, useBoard } from './test-app.ts'

describe('pull request workflow', () => {
  const PR = 'https://github.com/acme/app/pull/42'

  beforeEach(async () => {
    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Workflow',
      columns: ['Todo', 'In progress', 'Review', 'Done'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
    })
    useBoard(body.id)
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
      [
        initial.githubRepo,
        initial.agentEnabled,
        initial.agentName,
        initial.agentModel,
        initial.agentEffort,
        initial.agentConcurrency,
        initial.agentBacklog,
        initial.agentAllSkills,
      ],
      [null, false, null, null, null, null, false, false],
    )
    assert.equal(agentWorkerName(initial), 'claude/opus/medium')

    const off = await call('PATCH', `/boards/${boardId}`, { agentEnabled: true })
    assert.equal(off.status, 400, 'the agent needs a repository')
    assert.equal((await call('PATCH', `/boards/${boardId}`, { githubRepo: 'not a repo' })).status, 400)
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentName: 'has space' })).status, 400)
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentName: 'claude/opus' })).status, 400)
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentModel: 'opus/high' })).status, 400)
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentEffort: 'extreme' })).status, 400)
    for (const agentConcurrency of [0, 1.5, AGENT_MAX_CONCURRENCY + 1, '2']) {
      assert.equal((await call('PATCH', `/boards/${boardId}`, { agentConcurrency })).status, 400)
    }
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentBacklog: 'yes' })).status, 400)
    assert.equal((await call('PATCH', `/boards/${boardId}`, { agentAllSkills: 1 })).status, 400)

    const { body: on } = await call<BoardSummary>('PATCH', `/boards/${boardId}`, {
      githubRepo: 'acme/app',
      agentEnabled: true,
      agentName: 'claude-2',
      agentModel: 'claude-sonnet-5',
      agentEffort: 'xhigh',
      agentConcurrency: 3,
      agentBacklog: true,
      agentAllSkills: true,
    })
    assert.deepEqual(
      [on.githubRepo, on.agentEnabled, on.agentName, on.agentConcurrency, on.agentBacklog, on.agentAllSkills],
      ['acme/app', true, 'claude-2', 3, true, true],
    )
    assert.equal(agentWorkerName(on), 'claude-2/claude-sonnet-5/xhigh')
    const { body: boards } = await call<BoardSummary[]>('GET', '/boards')
    assert.ok(boards.some((board) => board.id === boardId && board.agentEnabled))

    const { body: cleared } = await call<BoardSummary>('PATCH', `/boards/${boardId}`, {
      agentEnabled: false,
      githubRepo: null,
      agentName: null,
      agentModel: null,
      agentEffort: null,
      agentConcurrency: null,
      agentBacklog: false,
      agentAllSkills: false,
    })
    assert.deepEqual(
      [
        cleared.githubRepo,
        cleared.agentEnabled,
        cleared.agentName,
        cleared.agentModel,
        cleared.agentEffort,
        cleared.agentConcurrency,
        cleared.agentBacklog,
        cleared.agentAllSkills,
      ],
      [null, false, null, null, null, null, false, false],
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

  test('tickets can set the model the agent works them with', async () => {
    const ticket = await addTicket({ title: 'Copy edit', agentModel: 'sonnet' })
    assert.equal(ticket.agentModel, 'sonnet')
    assert.equal((await addTicket({ title: 'Plain' })).agentModel, null, 'null follows the board')
    assert.equal((await call('PATCH', `/tickets/${ticket.id}`, { agentModel: 'two words' })).status, 400)

    const { body: changed } = await call<Ticket>('PATCH', `/tickets/${ticket.id}`, { agentModel: 'claude-haiku-4-5' })
    assert.equal(changed.agentModel, 'claude-haiku-4-5')
    const { body: exported } = await call<{ tickets: { title: string; agentModel: string | null }[] }>(
      'GET',
      `/boards/${boardId}/export`,
    )
    assert.equal(exported.tickets.find((entry) => entry.title === 'Copy edit')?.agentModel, 'claude-haiku-4-5')
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

  test('deleting a column clears it from the workflow', async () => {
    const { body: board } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    await call('DELETE', `/columns/${board.board.doneColumnId}`)
    const { body: after } = await call<BoardDetail>('GET', `/boards/${boardId}`)
    const deleted = await call('DELETE', `/boards/${boardId}`)

    assert.equal(after.board.doneColumnId, null)
    assert.equal(deleted.status, 204)
  })
})
