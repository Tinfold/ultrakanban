import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach } from 'node:test'
import { type Ticket } from '../shared/domain.ts'
import { createApp } from './app.ts'
import { createAttachmentFiles } from './attachment-files.ts'
import { createMergeQueue } from './merge-queue.ts'
import { type GitHubAuth, GitHubError, type GitHubPullRequest, type NewRepository } from './github.ts'
import { createPullRequestSync } from './pull-request-sync.ts'
import type { PullRequestStatus } from './store/tickets.ts'

/**
 * The app the server tests run against, with a fake GitHub, and helpers for calling its API. Importing it gives each test
 * a new board (`boardId`); each test file runs in its own process, with its own in-memory database.
 */

/** Fake GitHub: pull requests are open unless a test says otherwise. */
export const pullRequestStatuses = new Map<string, PullRequestStatus>()
/** Fake GitHub signed in as "octocat"; repositories it has created, as owner/name. */
export const github = { auth: 'env' as GitHubAuth, repos: new Set<string>(), created: [] as NewRepository[] }
/** Fake GitHub pull requests for merging, by `owner/name#number`. */
export const pulls = new Map<string, GitHubPullRequest & { files: string[] }>()
/** `head>base` pairs where `head` contains `base`'s commits. */
export const containing = new Set<string>()
/** Called after the fake merges a pull request, to change the others the way GitHub would. */
let afterMerge: (key: string) => void = () => {}
export const setAfterMerge = (fn: typeof afterMerge) => void (afterMerge = fn)
export const merges: string[] = []
export const pull = (repo: string, number: number) => {
  const found = pulls.get(`${repo}#${number}`)
  if (!found) throw new Error(`GitHub responded 404 for ${repo}#${number}`)
  return found
}
export const attachmentDir = mkdtempSync(join(tmpdir(), 'ultrakanban-attachments-'))
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
export const mergeQueue = createMergeQueue(pullRequests, { pollMs: 0 })
export const app = createApp({ attachmentFiles: createAttachmentFiles(attachmentDir), pullRequests, mergeQueue })

export async function call<T>(method: string, path: string, body?: unknown, actor = 'tester') {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}

export let boardId: string
/** Makes the tests that follow work on another board. */
export const useBoard = (id: string) => void (boardId = id)

export const ticketsIn = async (column: string) =>
  (await call<Ticket[]>('GET', `/boards/${boardId}/tickets?column=${encodeURIComponent(column)}`)).body

export const addTicket = async (input: Record<string, unknown>) =>
  (await call<Ticket>('POST', `/boards/${boardId}/tickets`, input)).body

beforeEach(async () => {
  const { body } = await call<{ id: string }>('POST', '/boards', {
    name: 'Test',
    columns: ['Todo', 'Doing', 'Done'],
  })
  useBoard(body.id)
})
