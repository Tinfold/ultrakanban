import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parsePullRequestUrl } from '../shared/domain.ts'
import type { PullRequestStatus } from './store/tickets.ts'

export type GitHubAuth = 'env' | 'gh' | null

export interface GitHubClient {
  /** Where the API token comes from; `null` means unauthenticated (public repos only, 60 requests/hour). */
  auth: () => Promise<GitHubAuth>
  fetchPullRequestStatus: (url: string) => Promise<PullRequestStatus>
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

  return {
    auth: async () => (await getCredentials()).auth,

    async fetchPullRequestStatus(url) {
      const pullRequest = parsePullRequestUrl(url)
      if (!pullRequest) throw new Error(`Not a pull request URL: ${url}`)
      const { token } = await getCredentials()
      const response = await fetch(`https://api.github.com/repos/${pullRequest.repo}/pulls/${pullRequest.number}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ultrakanban',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`GitHub responded ${response.status} for ${pullRequest.url}`)
      const data = (await response.json()) as {
        state: 'open' | 'closed'
        merged: boolean
        draft: boolean
        title: string
      }
      const state = data.merged ? 'merged' : data.state === 'closed' ? 'closed' : data.draft ? 'draft' : 'open'
      return { state, title: data.title }
    },
  }
}
