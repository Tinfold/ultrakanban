import { Hono } from 'hono'
import {
  listLocalPullRequestsQuerySchema,
  localPullRequestCommentSchema,
  openLocalPullRequestSchema,
} from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { badRequest, conflict, HttpError, notFound } from '../errors.ts'
import { actorOf, readJson } from '../http.ts'
import * as git from '../local-git.ts'
import { getBoard } from '../store/boards.ts'
import {
  addLocalPullRequestComment,
  finishLocalPullRequest,
  getLocalPullRequest,
  listLocalPullRequests,
  listOpenLocalPullRequests,
  openLocalPullRequest,
  recordLocalConflicts,
} from '../store/local-pull-requests.ts'
import { getTicket } from '../store/tickets.ts'

/** The pull request's number from the path; 404 unless it is a whole number. */
function numberOf(boardId: string, param: string) {
  const number = Number(param)
  if (!Number.isSafeInteger(number) || number < 1) throw notFound('Local pull request', `${boardId}#${param}`)
  return number
}

const repositoryOf = (boardId: string) => git.openRepository(getBoard(boardId).localRepoPath)

/** The commits a local pull request's diff and commits are between (see `git.resolveCommits`). */
async function commitsOf(boardId: string, number: number) {
  const pullRequest = getLocalPullRequest(boardId, number)
  const repo = await repositoryOf(boardId)
  return { repo, ...(await git.resolveCommits(repo, pullRequest)) }
}

/**
 * Checks whether an open local pull request merges cleanly as its branches are now (`git.mergeability`) and records
 * the answer on its ticket. Null when it isn't open, or its branches or the repository can't be read.
 */
async function checkMergeability(boardId: string, number: number) {
  const pullRequest = getLocalPullRequest(boardId, number)
  if (pullRequest.state !== 'open') return null
  try {
    const mergeability = await git.mergeability(await repositoryOf(boardId), pullRequest.base, pullRequest.head)
    if (mergeability) transaction(() => recordLocalConflicts(boardId, number, mergeability.conflicts.length > 0))
    return mergeability
  } catch {
    return null
  }
}

/** A local pull request with its `mergeability`. */
async function detailOf(boardId: string, number: number) {
  const mergeability = await checkMergeability(boardId, number)
  return { ...getLocalPullRequest(boardId, number), mergeability }
}

/**
 * Checks every open local pull request for merge conflicts with its base branch, which moves on as others merge, and
 * records them on their tickets (see `recordLocalConflicts`). Run with GitHub's sync; overlapping calls share one run.
 */
export const checkLocalConflicts = (() => {
  let running: Promise<void> | null = null
  return () =>
    (running ??= (async () => {
      for (const { boardId, number } of listOpenLocalPullRequests()) await checkMergeability(boardId, number)
    })().finally(() => (running = null)))
})()

/**
 * Merging and closing are one at a time per local pull request, so a close can't land while a merge is under way and
 * leave the merge commit on the base with the pull request closed: it waits, then finds it merged.
 */
const finishing = git.oneAtATime()

/**
 * Merges a local pull request in the board's local repository (see `git.merge`), then marks it merged, which moves its
 * ticket to the done column.
 */
export function mergeLocalPullRequest(boardId: string, number: number, actor: string) {
  return finishing(`${boardId}#${number}`, async () => {
    const pullRequest = getLocalPullRequest(boardId, number)
    if (pullRequest.state !== 'open') {
      throw conflict('pull_request_not_open', `Local pull request #${number} is ${pullRequest.state}`)
    }
    const repo = await repositoryOf(boardId)
    const merged = await git
      .merge(repo, {
        base: pullRequest.base,
        head: pullRequest.head,
        message: `Merge pull request #${number} from ${pullRequest.head}\n\n${pullRequest.title}`,
      })
      .catch((error: unknown) => {
        // Its agent can fix them now rather than at the next check.
        if (error instanceof HttpError && error.code === 'merge_conflicts') {
          transaction(() => recordLocalConflicts(boardId, number, true))
        }
        throw error
      })
    return transaction(() => finishLocalPullRequest(boardId, number, { state: 'merged', ...merged }, actor))
  })
}

/** Closes a local pull request without merging it. */
function closeLocalPullRequest(boardId: string, number: number, actor: string) {
  return finishing(`${boardId}#${number}`, async () => {
    const pullRequest = getLocalPullRequest(boardId, number)
    // Its branches' commits are kept, so its diff stays readable; neither is needed to close it.
    const repo = pullRequest.state === 'open' ? await repositoryOf(boardId).catch(() => null) : null
    const [headSha, baseSha] = repo
      ? [await git.branchSha(repo, pullRequest.head), await git.branchSha(repo, pullRequest.base)]
      : [null, null]
    return transaction(() => finishLocalPullRequest(boardId, number, { state: 'closed', headSha, baseSha }, actor))
  })
}

/** Local pull requests: on the board itself rather than on GitHub, for boards with a local repository. */
export const localPullRequestRoutes = new Hono()
  .post('/tickets/:ticketId/local-pull-request', async (c) => {
    const input = await readJson(c, openLocalPullRequestSchema)
    const ticket = getTicket(c.req.param('ticketId'))
    const repo = await repositoryOf(ticket.boardId)
    const base = input.base ?? (await git.defaultBranch(repo))
    if (base === input.head) throw badRequest('The head and base branches must differ')
    const [baseSha, headSha] = [await git.branchSha(repo, base), await git.branchSha(repo, input.head)]
    for (const [branch, sha] of [
      [base, baseSha],
      [input.head, headSha],
    ]) {
      if (!sha) throw badRequest(`The local repository has no branch "${branch}"; push it there first`)
    }
    if (await git.isAncestor(repo, headSha!, baseSha!)) {
      throw badRequest(`"${input.head}" has no commits that aren't on "${base}" yet`)
    }
    const pullRequest = transaction(() =>
      openLocalPullRequest(
        ticket.id,
        { head: input.head, base, title: input.title ?? ticket.title, body: input.body },
        actorOf(c),
      ),
    )
    return c.json(await detailOf(ticket.boardId, pullRequest.number), 201)
  })
  .get('/boards/:boardId/pull-requests', (c) => {
    const { state } = listLocalPullRequestsQuerySchema.parse(c.req.query())
    return c.json(listLocalPullRequests(c.req.param('boardId'), state))
  })
  .get('/boards/:boardId/pull-requests/:number', async (c) => {
    const boardId = c.req.param('boardId')
    return c.json(await detailOf(boardId, numberOf(boardId, c.req.param('number'))))
  })
  .get('/boards/:boardId/pull-requests/:number/diff', async (c) => {
    const boardId = c.req.param('boardId')
    const number = numberOf(boardId, c.req.param('number'))
    const { repo, base, head } = await commitsOf(boardId, number)
    const mergeability = await checkMergeability(boardId, number)
    return c.json({ ...(await git.diff(repo, base, head)), conflicts: mergeability?.conflicts ?? [] })
  })
  .get('/boards/:boardId/pull-requests/:number/commits', async (c) => {
    const boardId = c.req.param('boardId')
    const { repo, base, head } = await commitsOf(boardId, numberOf(boardId, c.req.param('number')))
    return c.json(await git.commits(repo, base, head))
  })
  .post('/boards/:boardId/pull-requests/:number/comments', async (c) => {
    const boardId = c.req.param('boardId')
    const number = numberOf(boardId, c.req.param('number'))
    const input = await readJson(c, localPullRequestCommentSchema)
    return c.json(
      transaction(() => addLocalPullRequestComment(boardId, number, input, actorOf(c))),
      201,
    )
  })
  .post('/boards/:boardId/pull-requests/:number/merge', async (c) => {
    const boardId = c.req.param('boardId')
    return c.json(await mergeLocalPullRequest(boardId, numberOf(boardId, c.req.param('number')), actorOf(c)))
  })
  .post('/boards/:boardId/pull-requests/:number/close', async (c) => {
    const boardId = c.req.param('boardId')
    return c.json(await closeLocalPullRequest(boardId, numberOf(boardId, c.req.param('number')), actorOf(c)))
  })
