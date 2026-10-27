import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import type {
  Activity,
  ApiErrorBody,
  LocalCommit,
  LocalPullRequest,
  LocalPullRequestComment,
  LocalPullRequestDetail,
  LocalPullRequestDiff,
  Ticket,
} from '../shared/domain.ts'
import { subscribeWake } from './events.ts'
import { addTicket, boardId, call, ticketsIn, useBoard } from './test-app.ts'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Tester',
  GIT_AUTHOR_EMAIL: 'tester@example.com',
  GIT_COMMITTER_NAME: 'Tester',
  GIT_COMMITTER_EMAIL: 'tester@example.com',
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trim()

/** Writes (or with `null` deletes) files in `dir` and commits them on its checked-out branch. */
function commit(dir: string, message: string, files: Record<string, string | null>) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) git(dir, 'rm', '-q', path)
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
      git(dir, 'add', path)
    }
  }
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

const lines = (count: number, change: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

describe('local pull requests', () => {
  let root: string
  /** The board's local repository, with `main` checked out. */
  let repo: string
  /** A clone of it, where branches are made and pushed back, as an agent does. */
  let work: string
  let ticket: Ticket
  const pr = (path = '') => `/boards/${boardId}/pull-requests${path}`

  /** Commits on a new branch in `work` and pushes it to the local repository. */
  function pushBranch(branch: string, files: Record<string, string | null>, message = `Change on ${branch}`) {
    git(work, 'checkout', '-q', '-B', branch, 'origin/main')
    const sha = commit(work, message, files)
    git(work, 'push', '-q', 'origin', branch)
    return sha
  }

  const open = (input: Record<string, unknown>, ticketId = ticket.id, actor = 'claude/opus/high') =>
    call<LocalPullRequestDetail & ApiErrorBody>('POST', `/tickets/${ticketId}/local-pull-request`, input, actor)

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ultrakanban-local-pr-'))
    repo = join(root, 'App')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    commit(repo, 'Initial commit', { 'README.md': '# App\n', 'src/main.ts': lines(20), 'old.txt': 'old\n' })
    git(root, 'clone', '-q', repo, 'work')
    work = join(root, 'work')

    const { body } = await call<{ id: string }>('POST', '/boards', {
      name: 'Local',
      columns: ['Todo', 'In progress', 'Review', 'Done'],
      reviewColumn: 'Review',
      doneColumn: 'Done',
      localRepoPath: repo,
    })
    useBoard(body.id)
    ticket = await addTicket({ title: 'Add a feature', column: 'In progress', assignee: 'claude/opus/high' })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('opening one links it to the ticket', async () => {
    pushBranch('feature', { 'src/main.ts': lines(20, { 3: 'changed' }) })
    const { status, body } = await open({ head: 'feature', body: 'What it does' })
    assert.equal(status, 201)
    assert.equal(body.number, 1)
    assert.equal(body.url, `/b/${boardId}/pr/1`)
    assert.deepEqual(
      [body.title, body.body, body.head, body.base, body.state, body.author, body.ticketNumber, body.comments],
      ['Add a feature', 'What it does', 'feature', 'main', 'open', 'claude/opus/high', ticket.number, []],
      "the title is the ticket's and the base the default branch, unless given",
    )

    const { body: linked } = await call<Ticket>('GET', `/tickets/${ticket.id}`)
    assert.deepEqual(
      linked.pullRequest && [linked.pullRequest.url, linked.pullRequest.repo, linked.pullRequest.number],
      [body.url, 'local/App', 1],
    )
    assert.equal(linked.pullRequest?.state, 'open')
    assert.equal(linked.pullRequest?.title, 'Add a feature')
    const { body: activity } = await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)
    assert.ok(activity.some((entry) => entry.type === 'pull_request' && entry.data.event === 'linked'))

    // Submitting it for review needs no pull request link: it has one, and naming it again is fine too.
    const review = await call<Ticket>('POST', `/tickets/${ticket.id}/review`, {
      agent: 'claude/opus/high',
      pullRequest: `http://localhost:4317${body.url}`,
    })
    assert.equal(review.status, 200)
    assert.equal(review.body.pullRequest?.url, body.url)

    pushBranch('other', { 'other.txt': 'x\n' })
    const second = await open({ head: 'other', base: 'feature', title: 'Stacked' })
    assert.deepEqual([second.body.number, second.body.base, second.body.title], [2, 'feature', 'Stacked'])

    const { body: list } = await call<LocalPullRequest[]>('GET', pr())
    assert.deepEqual(
      list.map((item) => item.number),
      [2, 1],
    )
    assert.deepEqual((await call<LocalPullRequest[]>('GET', pr('?state=merged'))).body, [])
    assert.equal((await call<LocalPullRequestDetail>('GET', pr('/1'))).body.title, 'Add a feature')
    assert.equal((await call('GET', pr('/3'))).status, 404)
    assert.equal((await call('GET', pr('/x'))).status, 404)
  })

  test('opening one is refused when it has nothing to merge, or its branches are missing', async () => {
    pushBranch('feature', { 'a.txt': 'a\n' })
    const refused = async (input: Record<string, unknown>, status = 400) => {
      const { status: actual, body } = await open(input)
      assert.equal(actual, status, JSON.stringify(input))
      return body.error
    }
    assert.match((await refused({ head: 'missing' })).message, /no branch "missing"/)
    assert.match((await refused({ head: 'feature', base: 'missing' })).message, /no branch "missing"/)
    assert.match((await refused({ head: 'main' })).message, /must differ/)
    git(work, 'push', '-q', 'origin', 'origin/main:refs/heads/empty')
    assert.match((await refused({ head: 'empty' })).message, /no commits/)
    await refused({ head: '-delete' })
    await refused({ head: '../x' })

    assert.equal((await open({ head: 'feature' })).status, 201)
    assert.equal((await refused({ head: 'feature' }, 409)).code, 'pull_request_exists')

    const other = await call<{ id: string }>('POST', '/boards', {
      name: 'GitHub',
      columns: ['Todo'],
      githubRepo: 'acme/app',
    })
    useBoard(other.body.id)
    const elsewhere = await addTicket({ title: 'B' })
    assert.match((await open({ head: 'feature' }, elsewhere.id)).body.error.message, /no local repository/)

    await call('PATCH', `/boards/${other.body.id}`, { localRepoPath: join(root, 'nowhere') })
    assert.match((await open({ head: 'feature' }, elsewhere.id)).body.error.message, /isn't there/)
    await call('PATCH', `/boards/${other.body.id}`, { localRepoPath: root })
    assert.match((await open({ head: 'feature' }, elsewhere.id)).body.error.message, /isn't a git repository/)
  })

  test('a ticket links only a local pull request opened for it', async () => {
    pushBranch('feature', { 'a.txt': 'a\n' })
    const { body } = await open({ head: 'feature' })
    const other = await addTicket({ title: 'Other' })
    const relink = await call<ApiErrorBody>('PATCH', `/tickets/${other.id}`, { pullRequest: body.url })
    assert.equal(relink.status, 400)
    assert.match(relink.body.error.message, /opened for another ticket/)
    const missing = await call<ApiErrorBody>('PATCH', `/tickets/${other.id}`, { pullRequest: `/b/${boardId}/pr/9` })
    assert.match(missing.body.error.message, /no local pull request/)
    const created = await call('POST', `/boards/${boardId}/tickets`, { title: 'New', pullRequest: body.url })
    assert.equal(created.status, 400)

    // Unlinked and linked again, it keeps its state rather than waiting for GitHub.
    await call('PATCH', `/tickets/${ticket.id}`, { pullRequest: null })
    const { body: relinked } = await call<Ticket>('PATCH', `/tickets/${ticket.id}`, { pullRequest: body.url })
    assert.equal(relinked.pullRequest?.state, 'open')
  })

  test('the diff and commits come from git, file by file', async () => {
    git(work, 'checkout', '-q', '-b', 'feature')
    commit(work, 'Change main', { 'src/main.ts': lines(21, { 3: 'three', 21: 'twenty-one' }) })
    git(work, 'mv', 'old.txt', 'renamed.txt')
    commit(work, 'Rename, add and delete\n\nWith a body.', { 'new file.txt': 'new\n', 'README.md': null })
    git(work, 'push', '-q', 'origin', 'feature')
    // Commits on main after it branched off aren't part of it.
    commit(repo, 'Elsewhere', { 'elsewhere.txt': 'x\n' })
    await open({ head: 'feature' })

    const { body: diff } = await call<LocalPullRequestDiff>('GET', pr('/1/diff'))
    assert.equal(diff.headSha, git(repo, 'rev-parse', 'feature'))
    assert.equal(diff.baseSha, git(repo, 'rev-parse', 'main~1'))
    const files = Object.fromEntries(diff.files.map((file) => [file.path, file]))
    assert.deepEqual(
      diff.files.map((file) => [file.path, file.status, file.oldPath, file.additions, file.deletions]).sort(),
      [
        ['README.md', 'deleted', null, 0, 1],
        ['new file.txt', 'added', null, 1, 0],
        ['renamed.txt', 'renamed', 'old.txt', 0, 0],
        ['src/main.ts', 'modified', null, 2, 1],
      ],
    )
    const [first, second] = files['src/main.ts'].hunks
    assert.deepEqual([first.oldStart, first.oldLines, first.newStart, first.newLines], [1, 6, 1, 6])
    assert.deepEqual(first.lines.slice(1, 4), [
      { type: 'context', oldLine: 2, newLine: 2, text: 'line 2' },
      { type: 'delete', oldLine: 3, newLine: null, text: 'line 3' },
      { type: 'add', oldLine: null, newLine: 3, text: 'three' },
    ])
    assert.match(second.header, /^@@ -18,3 \+18,4 @@/)
    assert.deepEqual(second.lines.at(-1), { type: 'add', oldLine: null, newLine: 21, text: 'twenty-one' })
    assert.deepEqual(files['renamed.txt'].hunks, [])

    const { body: commits } = await call<LocalCommit[]>('GET', pr('/1/commits'))
    assert.deepEqual(
      commits.map((c) => [c.subject, c.body, c.author, c.email]),
      [
        ['Change main', '', 'Tester', 'tester@example.com'],
        ['Rename, add and delete', 'With a body.', 'Tester', 'tester@example.com'],
      ],
    )
    assert.equal(commits[1].sha, diff.headSha)
    assert.ok(!Number.isNaN(Date.parse(commits[0].date)))

    // A binary file has no hunks.
    git(work, 'checkout', '-q', '-b', 'binary', 'origin/main')
    writeFileSync(join(work, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]))
    git(work, 'add', 'image.bin')
    git(work, 'commit', '-q', '-m', 'Binary')
    git(work, 'push', '-q', 'origin', 'binary')
    await open({ head: 'binary' })
    const { body: binary } = await call<LocalPullRequestDiff>('GET', pr('/2/diff'))
    assert.deepEqual(
      binary.files.map((file) => [file.path, file.binary, file.hunks]),
      [['image.bin', true, []]],
    )
  })

  test('comments, general or inline, wake the agent unless it wrote them', async () => {
    pushBranch('feature', { 'a.txt': 'a\n' })
    await open({ head: 'feature' })
    const woken: string[] = []
    const unsubscribe = subscribeWake(({ boardId: id }) => woken.push(id))
    try {
      const comment = (input: Record<string, unknown>, actor = 'reviewer') =>
        call<LocalPullRequestComment & ApiErrorBody>('POST', pr('/1/comments'), input, actor)
      const general = await comment({ body: 'Looks good' })
      assert.equal(general.status, 201)
      assert.deepEqual(
        [general.body.body, general.body.author, general.body.path, general.body.line, general.body.side],
        ['Looks good', 'reviewer', null, null, null],
      )
      assert.deepEqual(woken, [boardId])

      const inline = await comment({ body: 'Rename this', path: 'a.txt', line: 1 }, 'claude/opus/high')
      assert.deepEqual([inline.body.path, inline.body.line, inline.body.side], ['a.txt', 1, 'right'])
      assert.deepEqual(woken, [boardId], "the agent's own comment doesn't wake it")
      const left = await comment({ body: 'Was this needed?', path: 'a.txt', line: 1, side: 'left' })
      assert.equal(left.body.side, 'left')

      for (const input of [
        { body: '' },
        { body: 'x', line: 1 },
        { body: 'x', path: 'a.txt' },
        { body: 'x', side: 'left' },
      ]) {
        assert.equal((await comment(input)).status, 400, JSON.stringify(input))
      }
      assert.equal((await call('POST', `/boards/${boardId}/pull-requests/2/comments`, { body: 'x' })).status, 404)

      // A ticket comment posted on the pull request lands on the local one.
      const onTicket = await call<Activity>(
        'POST',
        `/tickets/${ticket.id}/comments`,
        { body: 'Fixed', pullRequest: true },
        'claude/opus/high',
      )
      assert.equal(onTicket.status, 201)
      const { body: detail } = await call<LocalPullRequestDetail>('GET', pr('/1'))
      assert.deepEqual(
        detail.comments.map((c) => [c.author, c.body]),
        [
          ['reviewer', 'Looks good'],
          ['claude/opus/high', 'Rename this'],
          ['reviewer', 'Was this needed?'],
          ['claude/opus/high', 'Fixed'],
        ],
      )
      assert.equal(detail.commentCount, 4)
      assert.equal(
        (onTicket.body.data as { pullRequestComment?: string }).pullRequestComment,
        `/b/${boardId}/pr/1#comment-${detail.comments[3].id}`,
      )
    } finally {
      unsubscribe()
    }
  })

  test('merging runs git merge --no-ff where the base is checked out and moves the ticket to done', async () => {
    const headSha = pushBranch('feature', { 'src/main.ts': lines(20, { 5: 'five' }) })
    commit(repo, 'Meanwhile on main', { 'other.txt': 'other\n' })
    const baseSha = git(repo, 'rev-parse', 'main')
    await open({ head: 'feature' })
    await call('POST', `/tickets/${ticket.id}/review`, { agent: 'claude/opus/high' })

    const { status, body } = await call<LocalPullRequestDetail>('POST', pr('/1/merge'), undefined, 'reviewer')
    assert.equal(status, 200)
    assert.deepEqual([body.state, body.closedBy, body.headSha, body.baseSha], ['merged', 'reviewer', headSha, baseSha])
    assert.equal(body.mergeSha, git(repo, 'rev-parse', 'main'))
    assert.equal(git(repo, 'rev-parse', 'main^1'), baseSha)
    assert.equal(git(repo, 'rev-parse', 'main^2'), headSha)
    assert.equal(git(repo, 'log', '-1', '--format=%s', 'main'), 'Merge pull request #1 from feature')
    assert.equal(readFileSync(join(repo, 'src/main.ts'), 'utf8'), lines(20, { 5: 'five' }), 'the worktree follows')
    assert.equal(git(repo, 'status', '--porcelain'), '')

    const { body: merged } = await call<Ticket>('GET', `/tickets/${ticket.id}`)
    assert.equal(merged.pullRequest?.state, 'merged')
    const { body: columns } = await call<{ columns: { id: string; name: string }[] }>('GET', `/boards/${boardId}`)
    assert.equal(columns.columns.find((column) => column.id === merged.columnId)?.name, 'Done')
    const { body: activity } = await call<Activity[]>('GET', `/tickets/${ticket.id}/activity`)
    const event = activity.find((entry) => entry.type === 'pull_request' && entry.data.event === 'merged')
    assert.equal(event?.actor, 'reviewer')

    // Its diff and commits stay readable after its branch is gone and the base moves on.
    git(repo, 'branch', '-q', '-D', 'feature')
    commit(repo, 'Later', { 'later.txt': 'later\n' })
    const { body: diff } = await call<LocalPullRequestDiff>('GET', pr('/1/diff'))
    assert.deepEqual(
      diff.files.map((file) => file.path),
      ['src/main.ts'],
    )
    assert.equal((await call<LocalCommit[]>('GET', pr('/1/commits'))).body.length, 1)

    const again = await call<ApiErrorBody>('POST', pr('/1/merge'))
    assert.deepEqual([again.status, again.body.error.code], [409, 'pull_request_not_open'])
  })

  test('merging refuses conflicts, changing nothing', async () => {
    pushBranch('feature', { 'src/main.ts': lines(20, { 5: 'theirs' }) })
    commit(repo, 'Conflicting', { 'src/main.ts': lines(20, { 5: 'ours' }) })
    const before = git(repo, 'rev-parse', 'main')
    await open({ head: 'feature' })

    const { status, body } = await call<ApiErrorBody>('POST', pr('/1/merge'))
    assert.deepEqual(
      [status, body.error.code, body.error.details],
      [409, 'merge_conflicts', { files: ['src/main.ts'] }],
    )
    assert.match(body.error.message, /conflict in src\/main\.ts/)
    assert.equal(git(repo, 'rev-parse', 'main'), before)
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.equal((await call<LocalPullRequestDetail>('GET', pr('/1'))).body.state, 'open')
  })

  test('merging without a worktree on the base: a bare repository, or the base not checked out', async () => {
    const bare = join(root, 'bare.git')
    git(root, 'clone', '-q', '--bare', repo, bare)
    await call('PATCH', `/boards/${boardId}`, { localRepoPath: bare })
    git(work, 'remote', 'set-url', 'origin', bare)
    git(work, 'fetch', '-q', 'origin')
    const headSha = pushBranch('feature', { 'a.txt': 'a\n' })
    const baseSha = git(bare, 'rev-parse', 'main')
    await open({ head: 'feature' })

    // Merged from the ticket, as the board's merge button does.
    const { status, body } = await call<Ticket>('POST', `/tickets/${ticket.id}/merge`, {})
    assert.equal(status, 200)
    assert.equal(body.pullRequest?.state, 'merged')
    assert.deepEqual([git(bare, 'rev-parse', 'main^1'), git(bare, 'rev-parse', 'main^2')], [baseSha, headSha])
    const { body: merged } = await call<LocalPullRequestDetail>('GET', pr('/1'))
    assert.equal(merged.mergeSha, git(bare, 'rev-parse', 'main'))

    // Into a branch nobody has checked out, in a repository with a worktree.
    git(repo, 'branch', '-q', 'release')
    pushBranch('fix', { 'b.txt': 'b\n' })
    await call('PATCH', `/boards/${boardId}`, { localRepoPath: repo })
    git(work, 'remote', 'set-url', 'origin', repo)
    git(work, 'fetch', '-q', 'origin')
    git(work, 'push', '-q', 'origin', 'fix')
    const fix = await addTicket({ title: 'Fix' })
    await open({ head: 'fix', base: 'release' }, fix.id)
    assert.equal((await call('POST', pr('/2/merge'))).status, 200)
    assert.equal(git(repo, 'rev-parse', 'release^2'), git(repo, 'rev-parse', 'fix'))
    assert.equal(git(repo, 'show', 'release:b.txt'), 'b')
  })

  test('closing keeps it unmerged, and the ticket where it is', async () => {
    const headSha = pushBranch('feature', { 'a.txt': 'a\n' })
    await open({ head: 'feature' })
    const { status, body } = await call<LocalPullRequestDetail>('POST', pr('/1/close'), undefined, 'reviewer')
    assert.equal(status, 200)
    assert.deepEqual([body.state, body.closedBy, body.headSha, body.mergeSha], ['closed', 'reviewer', headSha, null])
    const { body: closed } = await call<Ticket>('GET', `/tickets/${ticket.id}`)
    assert.equal(closed.pullRequest?.state, 'closed')
    assert.equal(closed.columnId, ticket.columnId)
    assert.equal(git(repo, 'ls-tree', '--name-only', 'main', 'a.txt'), '')
    assert.equal((await call('POST', pr('/1/merge'))).status, 409)
    assert.equal((await call('POST', pr('/1/close'))).status, 409)
    assert.deepEqual(
      (await call<LocalPullRequest[]>('GET', pr('?state=closed'))).body.map((item) => item.number),
      [1],
    )

    // A new one can be opened for the same branch once it is closed.
    assert.equal((await open({ head: 'feature' })).status, 201)
  })

  test('closing while a merge is under way waits for it, then finds it merged', async () => {
    const headSha = pushBranch('feature', { 'a.txt': 'a\n' })
    await open({ head: 'feature' })
    const [merge, close] = await Promise.all([
      call<LocalPullRequestDetail>('POST', pr('/1/merge')),
      call<ApiErrorBody>('POST', pr('/1/close')),
    ])
    assert.deepEqual([merge.status, merge.body.state], [200, 'merged'])
    assert.deepEqual([close.status, close.body.error.code], [409, 'pull_request_not_open'])
    assert.equal(git(repo, 'rev-parse', 'main^2'), headSha)
    assert.equal((await call<LocalPullRequestDetail>('GET', pr('/1'))).body.state, 'merged')
    assert.deepEqual(
      (await ticketsIn('Done')).map((done) => [done.id, done.pullRequest?.state]),
      [[ticket.id, 'merged']],
    )
  })

  test('a repository in the home directory, without a git identity of its own', async () => {
    const home = process.env.HOME
    process.env.HOME = root
    try {
      await call('PATCH', `/boards/${boardId}`, { localRepoPath: `~/${basename(repo)}` })
      const headSha = pushBranch('feature', { 'a.txt': 'a\n' })
      git(repo, 'checkout', '-q', '--detach')
      await open({ head: 'feature', base: 'main' })
      assert.equal((await call('POST', pr('/1/merge'))).status, 200)
      assert.equal(git(repo, 'rev-parse', 'main^2'), headSha)
      assert.equal(
        execFileSync('git', ['log', '-1', '--format=%an', 'main'], { cwd: repo, encoding: 'utf8' }).trim(),
        'ultrakanban',
      )
    } finally {
      process.env.HOME = home
    }
  })

  test('~/ is ULTRAKANBAN_HOME when it is set: the host home directory a board in Docker sees', async () => {
    process.env.ULTRAKANBAN_HOME = root
    try {
      await call('PATCH', `/boards/${boardId}`, { localRepoPath: `~/${basename(repo)}` })
      pushBranch('feature', { 'a.txt': 'a\n' })
      assert.equal((await open({ head: 'feature' })).status, 201)
    } finally {
      delete process.env.ULTRAKANBAN_HOME
    }
  })
})
