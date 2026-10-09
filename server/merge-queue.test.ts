import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { type ApiErrorBody, type MergePlan, type MergeRun, type Ticket } from '../shared/domain.ts'
import { type GitHubPullRequest } from './github.ts'
import {
  addTicket,
  boardId,
  branches,
  call,
  containing,
  deletedBranches,
  merges,
  mergeQueue,
  pull,
  pullRequestStatuses,
  pulls,
  setAfterMerge,
  ticketsIn,
  useBoard,
} from './test-app.ts'

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
    useBoard(body.id)
    for (const map of [pulls, pullRequestStatuses, containing, branches]) map.clear()
    merges.length = 0
    deletedBranches.length = 0
    setAfterMerge(() => {})
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
    setAfterMerge((key) => {
      if (key === `${REPO}#1`) Object.assign(pull(REPO, 2), { mergeable: false, mergeableState: 'dirty' })
    })

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

  test('auto-merge merges only pull requests that are ready, and only on boards that have it on', async () => {
    const ready = await inReview(1)
    const stackedOnReady = await inReview(2, { base: 'branch-1' })
    await inReview(3, { mergeableState: 'unstable' })
    await inReview(4, { mergeableState: 'blocked' })
    await inReview(5, { mergeable: false, mergeableState: 'dirty' })
    await inReview(6, { draft: true })
    await inReview(7, { base: 'branch-3' })
    const unchecked = await inReview(8)
    await call('PATCH', `/tickets/${unchecked}`, { description: '- [x] one\n- [ ] two' })
    const checked = await inReview(9)
    await call('PATCH', `/tickets/${checked}`, { description: '- [x] one\n- [x] two' })

    await mergeQueue.autoMergeAll()
    assert.deepEqual(merges, [])

    await call('PATCH', `/boards/${boardId}`, { autoMerge: true })
    await mergeQueue.autoMergeAll()

    assert.deepEqual(merges, ['acme/app#1:merge', 'acme/app#2:merge', 'acme/app#9:merge'])
    const { body: run } = await call<MergeRun>('GET', `/boards/${boardId}/merge-run`)
    assert.equal(run.actor, 'auto-merge')
    assert.deepEqual(
      run.steps.map((step) => [step.number, step.status]),
      [
        [1, 'merged'],
        [2, 'merged'],
        [9, 'merged'],
      ],
    )
    assert.deepEqual(
      (await ticketsIn('Done')).map((ticket) => ticket.id).sort(),
      [ready, stackedOnReady, checked].sort(),
    )

    // Nothing ready is left, so it starts no run.
    assert.equal(await mergeQueue.autoMerge(boardId), null)
    assert.equal((await call<MergeRun>('GET', `/boards/${boardId}/merge-run`)).body.id, run.id)
  })

  describe('deleting branches after merge', () => {
    /** Adds a ticket in review whose branch exists on the fake GitHub at the pull request's head. */
    async function withBranch(number: number, pullRequest: Parameters<typeof inReview>[1] = {}) {
      const id = await inReview(number, pullRequest)
      const { head, headSha } = pull(REPO, number)
      branches.set(`${REPO}:${head}`, headSha)
      return id
    }

    beforeEach(() => call('PATCH', `/boards/${boardId}`, { deleteMergedBranches: true }))

    test('deletes merged branches, moving the pull requests based on them to their base first', async () => {
      await withBranch(1, { base: 'branch-2' })
      await withBranch(2)
      await withBranch(3, { base: 'branch-2', draft: true })

      const run = await runToEnd()

      assert.deepEqual(
        run.steps.map((step) => [step.number, step.status]),
        [
          [2, 'merged'],
          [1, 'merged'],
          [3, 'skipped'],
        ],
      )
      assert.deepEqual(deletedBranches, ['acme/app:branch-2', 'acme/app:branch-1'])
      assert.equal(pull(REPO, 3).base, 'main')
      assert.equal(pull(REPO, 3).state, 'open')
      assert.deepEqual([...branches.keys()], ['acme/app:branch-3'])
    })

    test('deletes the branch of a pull request merged on GitHub', async () => {
      const ticket = await withBranch(1)
      Object.assign(pull(REPO, 1), { merged: true, state: 'closed' })
      pullRequestStatuses.set(url(1), { state: 'merged', title: 'PR 1' })

      await call('POST', `/tickets/${ticket}/pull-request/sync`)
      await call('POST', `/tickets/${ticket}/pull-request/sync`)

      assert.deepEqual(deletedBranches, ['acme/app:branch-1'])
    })

    test('keeps branches in forks, the default branch and branches with newer commits', async () => {
      await withBranch(1, { headRepo: 'someone/app' })
      await withBranch(2, { head: 'main', base: 'release' })
      await withBranch(3)
      branches.set(`${REPO}:branch-3`, 'sha-newer')

      const run = await runToEnd()

      assert.deepEqual(
        run.steps.map((step) => step.status),
        ['merged', 'merged', 'merged'],
      )
      assert.deepEqual(deletedBranches, [])
    })

    test('keeps branches on boards without the setting', async () => {
      await call('PATCH', `/boards/${boardId}`, { deleteMergedBranches: false })
      await withBranch(1)

      await runToEnd()

      assert.deepEqual(merges, ['acme/app#1:merge'])
      assert.deepEqual(deletedBranches, [])
    })
  })
})
