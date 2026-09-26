import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MERGE_METHODS, type MergeMethod, parsePullRequestUrl } from '../shared/domain.ts'
import type { PullRequestStatus } from './store/tickets.ts'

export type GitHubAuth = 'env' | 'gh' | null

/** What merging needs to know about a pull request. */
export interface GitHubPullRequest {
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  title: string
  /** `null` while GitHub is still computing it. */
  mergeable: boolean | null
  /** GitHub's `mergeable_state`: `clean`, `dirty` (conflicts), `blocked`, `behind`, `unstable`, `unknown`… */
  mergeableState: string
  base: string
  head: string
  headSha: string
}

export interface GitHubClient {
  /** Where the API token comes from; `null` means unauthenticated (public repos only, 60 requests/hour). */
  auth: () => Promise<GitHubAuth>
  fetchPullRequestStatus: (url: string) => Promise<PullRequestStatus>
  getPullRequest: (repo: string, number: number) => Promise<GitHubPullRequest>
  /** Paths the pull request changes (at most the first 300). */
  listPullRequestFiles: (repo: string, number: number) => Promise<string[]>
  /** Whether `head` contains every commit of `base`. */
  containsCommit: (repo: string, head: string, base: string) => Promise<boolean>
  /** Merge methods the repository allows. */
  mergeMethods: (repo: string) => Promise<MergeMethod[]>
  /** Merges the pull request, only if its head is still `sha`. */
  mergePullRequest: (repo: string, number: number, options: { method: MergeMethod; sha: string }) => Promise<void>
  /** Changes the branch the pull request merges into. */
  setPullRequestBase: (repo: string, number: number, base: string) => Promise<void>
}

async function resolveToken(): Promise<{ token: string | null; auth: GitHubAuth }> {
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (envToken) return { token: envToken, auth: 'env' }
  try {
    const { stdout } = await promisify(execFile)('gh', ['auth', 'token'], { timeout: 5000 })
    if (stdout.trim()) return { token: stdout.trim(), auth: 'gh' }
  } catch {
    // gh is not installed or not logged in.
  }
  return { token: null, auth: null }
}

interface PullRequestResponse {
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  title: string
  mergeable: boolean | null
  mergeable_state: string
  base: { ref: string }
  head: { ref: string; sha: string }
}

const REPO_MERGE_SETTINGS: Record<MergeMethod, string> = {
  merge: 'allow_merge_commit',
  squash: 'allow_squash_merge',
  rebase: 'allow_rebase_merge',
}

/** GitHub REST client authenticated with GITHUB_TOKEN / GH_TOKEN or the GitHub CLI's login. */
export function createGitHubClient(): GitHubClient {
  let credentials: ReturnType<typeof resolveToken> | undefined
  const getCredentials = () => (credentials ??= resolveToken())

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { token } = await getCredentials()
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ultrakanban',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(`GitHub responded ${response.status} for ${path}${data?.message ? `: ${data.message}` : ''}`)
    }
    return (await response.json()) as T
  }

  async function getPullRequest(repo: string, number: number): Promise<GitHubPullRequest> {
    const data = await request<PullRequestResponse>('GET', `/repos/${repo}/pulls/${number}`)
    return {
      state: data.state,
      merged: data.merged,
      draft: data.draft,
      title: data.title,
      mergeable: data.mergeable,
      mergeableState: data.mergeable_state,
      base: data.base.ref,
      head: data.head.ref,
      headSha: data.head.sha,
    }
  }

  return {
    auth: async () => (await getCredentials()).auth,

    async fetchPullRequestStatus(url) {
      const pullRequest = parsePullRequestUrl(url)
      if (!pullRequest) throw new Error(`Not a pull request URL: ${url}`)
      const data = await getPullRequest(pullRequest.repo, pullRequest.number)
      const state = data.merged ? 'merged' : data.state === 'closed' ? 'closed' : data.draft ? 'draft' : 'open'
      return { state, title: data.title }
    },

    getPullRequest,

    async listPullRequestFiles(repo, number) {
      const files: string[] = []
      for (let page = 1; page <= 3; page++) {
        const batch = await request<{ filename: string }[]>(
          'GET',
          `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
        )
        files.push(...batch.map((file) => file.filename))
        if (batch.length < 100) break
      }
      return files
    },

    async containsCommit(repo, head, base) {
      const data = await request<{ status: string }>('GET', `/repos/${repo}/compare/${base}...${head}`)
      return data.status === 'ahead' || data.status === 'identical'
    },

    async mergeMethods(repo) {
      const data = await request<Partial<Record<string, boolean>>>('GET', `/repos/${repo}`)
      // The settings are only included for people who can push; then any method may work.
      return MERGE_METHODS.filter((method) => data[REPO_MERGE_SETTINGS[method]] !== false)
    },

    async mergePullRequest(repo, number, { method, sha }) {
      await request('PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha })
    },

    async setPullRequestBase(repo, number, base) {
      await request('PATCH', `/repos/${repo}/pulls/${number}`, { base })
    },
  }
}
