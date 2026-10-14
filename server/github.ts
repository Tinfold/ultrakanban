import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  type GitHubAuthSource,
  MERGE_METHODS,
  type MergeMethod,
  parsePullRequestUrl,
  type PullRequestState,
} from '../shared/domain.ts'

export type GitHubAuth = GitHubAuthSource | null

export interface NewRepository {
  /** User or organization to create it under; the signed-in user when omitted. */
  owner?: string
  name: string
  description?: string
  private: boolean
}

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
  /** Repository the head branch is in, as owner/name: another one for a fork, `null` once the fork is deleted. */
  headRepo: string | null
  headSha: string
}

/** A pull request's state as the board tracks it; the checks of its head commit are read on their own (see checks.ts). */
export interface GitHubPullRequestStatus {
  state: Exclude<PullRequestState, 'unknown'>
  title: string | null
  /** Whether it has merge conflicts with its base branch; `null` while GitHub is still working it out. */
  conflicts: boolean | null
  /** Its head commit, whose checks count. */
  headSha: string
}

/** A check run on a commit: a GitHub Actions job, or another GitHub app's check. */
export interface GitHubCheckRun {
  id: number
  name: string
  /** `queued`, `in_progress`, `completed`, `waiting`, `requested` or `pending`. */
  status: string
  /**
   * How it ended, once completed: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`,
   * `action_required`, `startup_failure` or `stale`.
   */
  conclusion: string | null
  /** Its page on GitHub, or on the service that ran it. */
  detailsUrl: string | null
  /** What it reported about itself (the summary is Markdown), and how many annotations it left on the code. */
  output: { title: string | null; summary: string | null; annotationsCount: number }
}

/** A commit status, as older CI integrations report them: the latest one of each context. */
export interface GitHubCommitStatus {
  context: string
  state: 'error' | 'failure' | 'pending' | 'success'
  description: string | null
  targetUrl: string | null
}

/** A note a check run left on the code, such as a failing test or a compiler error. */
export interface GitHubAnnotation {
  /** `notice`, `warning` or `failure`. */
  level: string
  title: string | null
  message: string
  path: string | null
  line: number | null
}

export interface GitHubClient {
  /** Where the API token comes from; `null` means unauthenticated (public repos only, 60 requests/hour). */
  auth: () => Promise<GitHubAuth>
  /** The account the token belongs to; `error` when there is no token or GitHub turns it down. */
  account: () => Promise<{ login: string | null; error: string | null }>
  /** The account a token belongs to, before using it; throws a `GitHubError` when GitHub turns it down. */
  verifyToken: (token: string) => Promise<string>
  /** Looks for the token again, after it was changed on the Setup page. */
  resetAuth: () => void
  fetchPullRequestStatus: (url: string) => Promise<GitHubPullRequestStatus>
  /** The latest check runs on a commit (at most the first 300); GitHub may still list earlier runs of a re-run check. */
  listCheckRuns: (repo: string, sha: string) => Promise<GitHubCheckRun[]>
  /** The latest commit status of each context on a commit. */
  listCommitStatuses: (repo: string, sha: string) => Promise<GitHubCommitStatus[]>
  /** The annotations a check run left (at most the first 50). */
  listCheckRunAnnotations: (repo: string, checkRunId: number) => Promise<GitHubAnnotation[]>
  /** Creates a repository with an initial commit, so it has a default branch to clone and branch from. */
  createRepository: (input: NewRepository) => Promise<{ repo: string; url: string }>
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
  /** Numbers of the open pull requests that merge into `base`. */
  listPullRequestsInto: (repo: string, base: string) => Promise<number[]>
  defaultBranch: (repo: string) => Promise<string>
  /** The commit the branch points at; `null` when there is no such branch. */
  branchSha: (repo: string, branch: string) => Promise<string | null>
  deleteBranch: (repo: string, branch: string) => Promise<void>
  /** Posts a comment on the pull request's conversation; returns the comment's URL. */
  commentOnPullRequest: (repo: string, number: number, body: string) => Promise<string>
}

/** A request GitHub answered with an error status; `message` includes GitHub's reasons. */
export class GitHubError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function resolveToken(storedToken: () => string | null): Promise<{ token: string | null; auth: GitHubAuth }> {
  const stored = storedToken()
  if (stored) return { token: stored, auth: 'board' }
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
  head: { ref: string; sha: string; repo: { full_name: string } | null }
}

interface CheckRunResponse {
  id: number
  name: string
  status: string
  conclusion: string | null
  details_url: string | null
  html_url: string | null
  output?: { title: string | null; summary: string | null; annotations_count: number } | null
}

interface CommitStatusResponse {
  context: string
  state: GitHubCommitStatus['state']
  description: string | null
  target_url: string | null
}

interface AnnotationResponse {
  annotation_level: string | null
  title: string | null
  message: string | null
  path: string | null
  start_line: number | null
}

/** A branch name for a path, keeping its slashes. */
const branchPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/')

const REPO_MERGE_SETTINGS: Record<MergeMethod, string> = {
  merge: 'allow_merge_commit',
  squash: 'allow_squash_merge',
  rebase: 'allow_rebase_merge',
}

/**
 * GitHub REST client authenticated with the token set on the Setup page (`storedToken`), GITHUB_TOKEN / GH_TOKEN, or
 * the GitHub CLI's login, in that order.
 */
export function createGitHubClient(storedToken: () => string | null = () => null): GitHubClient {
  let credentials: ReturnType<typeof resolveToken> | undefined
  const getCredentials = () => (credentials ??= resolveToken(storedToken))

  async function request<T>(method: string, path: string, body?: unknown, withToken?: string): Promise<T> {
    const token = withToken ?? (await getCredentials()).token
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
    if (response.status === 204) return undefined as T
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
      headRepo: data.head.repo?.full_name ?? null,
      headSha: data.head.sha,
    }
  }

  return {
    auth: async () => (await getCredentials()).auth,

    async account() {
      if (!(await getCredentials()).token) return { login: null, error: 'No GitHub token' }
      try {
        return { login: await getLogin(), error: null }
      } catch (error) {
        return { login: null, error: error instanceof Error ? error.message : String(error) }
      }
    },

    verifyToken: async (token) => (await request<{ login: string }>('GET', '/user', undefined, token)).login,

    resetAuth() {
      credentials = undefined
      login = undefined
    },

    async fetchPullRequestStatus(url) {
      const pullRequest = parsePullRequestUrl(url)
      if (!pullRequest) throw new Error(`Not a pull request URL: ${url}`)
      const data = await getPullRequest(pullRequest.repo, pullRequest.number)
      const state = data.merged ? 'merged' : data.state === 'closed' ? 'closed' : data.draft ? 'draft' : 'open'
      return {
        state,
        title: data.title,
        conflicts: data.mergeable === null ? null : !data.mergeable,
        headSha: data.headSha,
      }
    },

    async listCheckRuns(repo, sha) {
      const runs: GitHubCheckRun[] = []
      for (let page = 1; page <= 3; page++) {
        const batch = await request<{ check_runs: CheckRunResponse[] }>(
          'GET',
          `/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
        )
        runs.push(
          ...batch.check_runs.map((run) => ({
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            detailsUrl: run.details_url ?? run.html_url,
            output: {
              title: run.output?.title ?? null,
              summary: run.output?.summary ?? null,
              annotationsCount: run.output?.annotations_count ?? 0,
            },
          })),
        )
        if (batch.check_runs.length < 100) break
      }
      return runs
    },

    async listCommitStatuses(repo, sha) {
      const data = await request<{ statuses: CommitStatusResponse[] }>(
        'GET',
        `/repos/${repo}/commits/${sha}/status?per_page=100`,
      )
      return data.statuses.map((status) => ({
        context: status.context,
        state: status.state,
        description: status.description,
        targetUrl: status.target_url,
      }))
    },

    async listCheckRunAnnotations(repo, checkRunId) {
      const data = await request<AnnotationResponse[]>(
        'GET',
        `/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=50`,
      )
      return data.map((annotation) => ({
        level: annotation.annotation_level ?? 'notice',
        title: annotation.title || null,
        message: annotation.message ?? '',
        path: annotation.path || null,
        line: annotation.start_line,
      }))
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

    async listPullRequestsInto(repo, base) {
      const numbers: number[] = []
      for (let page = 1; page <= 3; page++) {
        const batch = await request<{ number: number }[]>(
          'GET',
          `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100&page=${page}`,
        )
        numbers.push(...batch.map((pullRequest) => pullRequest.number))
        if (batch.length < 100) break
      }
      return numbers
    },

    defaultBranch: async (repo) => (await request<{ default_branch: string }>('GET', `/repos/${repo}`)).default_branch,

    async branchSha(repo, branch) {
      try {
        const ref = await request<{ object: { sha: string } }>(
          'GET',
          `/repos/${repo}/git/ref/heads/${branchPath(branch)}`,
        )
        return ref.object.sha
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return null
        throw error
      }
    },

    async deleteBranch(repo, branch) {
      await request('DELETE', `/repos/${repo}/git/refs/heads/${branchPath(branch)}`)
    },

    async commentOnPullRequest(repo, number, body) {
      const comment = await request<{ html_url: string }>('POST', `/repos/${repo}/issues/${number}/comments`, { body })
      return comment.html_url
    },
  }
}
