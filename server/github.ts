import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parsePullRequestUrl } from '../shared/domain.ts'
import type { PullRequestStatus } from './store/tickets.ts'

export type GitHubAuth = 'env' | 'gh' | null

export interface NewRepository {
  /** User or organization to create it under; the signed-in user when omitted. */
  owner?: string
  name: string
  description?: string
  private: boolean
}

export interface GitHubClient {
  /** Where the API token comes from; `null` means unauthenticated (public repos only, 60 requests/hour). */
  auth: () => Promise<GitHubAuth>
  fetchPullRequestStatus: (url: string) => Promise<PullRequestStatus>
  /** Creates a repository with an initial commit, so it has a default branch to clone and branch from. */
  createRepository: (input: NewRepository) => Promise<{ repo: string; url: string }>
}

/** A request GitHub answered with an error status; `message` includes GitHub's reasons. */
export class GitHubError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
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
      const data = (await response.json().catch(() => null)) as {
        message?: string
        errors?: ({ message?: string } | string)[]
      } | null
      const reasons = (data?.errors ?? []).map((error) => (typeof error === 'string' ? error : error.message))
      const message = [data?.message ?? `GitHub responded ${response.status}`, ...reasons.filter(Boolean)].join(': ')
      throw new GitHubError(response.status, `${message} (${method} ${path})`)
    }
    return (await response.json()) as T
  }

  let login: Promise<string> | undefined
  const getLogin = () =>
    (login ??= request<{ login: string }>('GET', '/user').then(
      (user) => user.login,
      (error: unknown) => {
        login = undefined
        throw error
      },
    ))

  return {
    auth: async () => (await getCredentials()).auth,

    async fetchPullRequestStatus(url) {
      const pullRequest = parsePullRequestUrl(url)
      if (!pullRequest) throw new Error(`Not a pull request URL: ${url}`)
      const data = await request<{ state: 'open' | 'closed'; merged: boolean; draft: boolean; title: string }>(
        'GET',
        `/repos/${pullRequest.repo}/pulls/${pullRequest.number}`,
      )
      const state = data.merged ? 'merged' : data.state === 'closed' ? 'closed' : data.draft ? 'draft' : 'open'
      return { state, title: data.title }
    },

    async createRepository({ owner, name, description, private: isPrivate }) {
      const forUser = !owner || owner.toLowerCase() === (await getLogin()).toLowerCase()
      const created = await request<{ full_name: string; html_url: string }>(
        'POST',
        forUser ? '/user/repos' : `/orgs/${encodeURIComponent(owner)}/repos`,
        { name, description, private: isPrivate, auto_init: true },
      )
      return { repo: created.full_name, url: created.html_url }
    },
  }
}
