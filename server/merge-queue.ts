import {
  MERGE_METHODS,
  type MergeMethod,
  type MergePlan,
  type MergePlanItem,
  type MergeRun,
  type MergeRunStep,
  type Ticket,
} from '../shared/domain.ts'
import { newId, now } from './db.ts'
import { badRequest, conflict } from './errors.ts'
import type { GitHubPullRequest } from './github.ts'
import type { PullRequestSync } from './pull-request-sync.ts'
import { getBoard } from './store/boards.ts'
import { listTickets } from './store/tickets.ts'

export interface MergeQueueOptions {
  /** Wait between checks while GitHub works out whether a pull request can be merged, and after each merge. */
  pollMs?: number
  /** Checks before going ahead without GitHub's answer. */
  maxPolls?: number
}

export type MergeQueue = ReturnType<typeof createMergeQueue>

interface PlanEntry {
  item: MergePlanItem
  /** Position in the review column, the order used when nothing else decides. */
  index: number
  pullRequest: GitHubPullRequest | null
  files: Set<string>
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Why a pull request can't be merged at all, if it can't. */
function skipReason(pullRequest: GitHubPullRequest) {
  if (pullRequest.merged) return 'Already merged'
  if (pullRequest.state === 'closed') return 'Closed without merging'
  if (pullRequest.draft) return 'Still a draft'
  if (pullRequest.mergeable === false) return `Has conflicts with ${pullRequest.base}`
  return null
}

/** Why GitHub may refuse the merge, though it is still worth trying (admins can bypass branch protection). */
function warning(pullRequest: GitHubPullRequest) {
  if (pullRequest.mergeable === null) return 'GitHub is still checking whether it can be merged'
  switch (pullRequest.mergeableState) {
    case 'blocked':
      return 'Branch protection blocks it: required reviews or checks are missing'
    case 'behind':
      return `Behind ${pullRequest.base}, and branch protection requires it to be up to date`
    case 'unstable':
      return 'Some checks are failing'
    default:
      return null
  }
}

/**
 * Orders pull requests so each merges after the ones it builds on, keeping the review column's order otherwise.
 * Ties within a cycle (which GitHub shouldn't produce) fall back to column order.
 */
function mergeOrder(entries: PlanEntry[]) {
  const byTicket = new Map(entries.map((entry) => [entry.item.ticketId, entry]))
  const ordered: PlanEntry[] = []
  const placed = new Set<string>()
  const remaining = [...entries].sort((a, b) => a.index - b.index)
  while (remaining.length) {
    const next =
      remaining.find((entry) => entry.item.after.every((id) => placed.has(id) || !byTicket.has(id))) ?? remaining[0]
    remaining.splice(remaining.indexOf(next), 1)
    placed.add(next.item.ticketId)
    ordered.push(next)
  }
  return ordered
}

/**
 * Merges a board's reviewed pull requests one at a time in an order that avoids needless conflicts: stacked pull
 * requests (and ones containing another's commits) after the ones they build on, otherwise in review column
 * order. After each merge GitHub checks the rest again; any that conflict by then are skipped, so their agents
 * can resolve the conflicts, and the others still merge.
 */
export function createMergeQueue(
  pullRequests: PullRequestSync,
  { pollMs = 2000, maxPolls = 15 }: MergeQueueOptions = {},
) {
  const { github } = pullRequests
  /** The latest run per board. */
  const runs = new Map<string, MergeRun>()
  const starting = new Set<string>()

  /** Reads a pull request, giving GitHub time to compute whether it can be merged. */
  async function fetchSettled(repo: string, number: number) {
    let pullRequest = await github.getPullRequest(repo, number)
    for (let poll = 1; poll < maxPolls && pullRequest.state === 'open' && pullRequest.mergeable === null; poll++) {
      await sleep(pollMs)
      pullRequest = await github.getPullRequest(repo, number)
    }
    return pullRequest
  }

  async function describe(ticket: Ticket, index: number): Promise<PlanEntry> {
    const { url, repo, number, title } = ticket.pullRequest!
    const item: MergePlanItem = {
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      ticketTitle: ticket.title,
      url,
      repo,
      number,
      title,
      base: null,
      head: null,
      headSha: null,
      after: [],
      overlaps: [],
      warning: null,
      skip: null,
    }
    try {
      const pullRequest = await fetchSettled(repo, number)
      const files = pullRequest.state === 'open' ? await github.listPullRequestFiles(repo, number) : []
      Object.assign(item, {
        title: pullRequest.title,
        base: pullRequest.base,
        head: pullRequest.head,
        headSha: pullRequest.headSha,
        warning: warning(pullRequest),
        skip: skipReason(pullRequest),
      })
      return { item, index, pullRequest, files: new Set(files) }
    } catch (error) {
      item.skip = `Couldn't read it from GitHub: ${errorMessage(error)}`
      return { item, index, pullRequest: null, files: new Set() }
    }
  }

  /** Whether `b` builds on `a`: stacked on its branch, or containing its commits. */
  async function buildsOn(b: PlanEntry, a: PlanEntry, overlapping: boolean) {
    if (!a.pullRequest || !b.pullRequest || a.item.repo !== b.item.repo) return false
    if (b.pullRequest.base === a.pullRequest.head) return true
    // Containing another's commits means changing its files too, so only overlapping pairs need checking.
    if (!overlapping || a.pullRequest.headSha === b.pullRequest.headSha) return false
    return github.containsCommit(b.item.repo, b.pullRequest.headSha, a.pullRequest.headSha).catch(() => false)
  }

  async function plan(boardId: string): Promise<MergePlan> {
    const reviewColumnId = getBoard(boardId).reviewColumnId
    if (!reviewColumnId) throw badRequest('This board has no review column; choose one in the board settings')
    if (!(await github.auth())) {
      throw badRequest('Merging needs a GitHub token: set GITHUB_TOKEN or log in with the GitHub CLI (gh auth login)')
    }
    const tickets = listTickets(boardId, { column: reviewColumnId }).filter(
      (ticket) => ticket.pullRequest && !['merged', 'closed'].includes(ticket.pullRequest.state),
    )
    const entries = await Promise.all(tickets.map(describe))

    const pairs = entries.flatMap((a, i) => entries.slice(i + 1).map((b) => [a, b] as const))
    await Promise.all(
      pairs.map(async ([a, b]) => {
        const overlapping = [...a.files].some((file) => b.files.has(file))
        if (overlapping) {
          a.item.overlaps.push(b.item.ticketId)
          b.item.overlaps.push(a.item.ticketId)
        }
        if (await buildsOn(b, a, overlapping)) b.item.after.push(a.item.ticketId)
        else if (await buildsOn(a, b, overlapping)) a.item.after.push(b.item.ticketId)
      }),
    )

    const ordered = mergeOrder(entries).map((entry) => entry.item)
    const byTicket = new Map(ordered.map((item) => [item.ticketId, item]))
    for (const item of ordered) {
      const blocked = item.after.map((id) => byTicket.get(id)!).find((parent) => parent.skip)
      item.skip ??= blocked ? `Builds on #${blocked.ticketNumber}, which won't be merged` : null
    }

    const repos = [...new Set(ordered.filter((item) => !item.skip).map((item) => item.repo))]
    const allowed = await Promise.all(repos.map((repo) => github.mergeMethods(repo).catch(() => [...MERGE_METHODS])))
    const methods = MERGE_METHODS.filter((method) => allowed.every((repoMethods) => repoMethods.includes(method)))
    return { items: ordered, methods }
  }

  async function mergeStep(run: MergeRun, step: MergeRunStep, merged: Map<string, GitHubPullRequest>) {
    const { repo, number } = step
    let pullRequest = await github.getPullRequest(repo, number)
    // Stacked on a branch merged earlier in this run: retarget it to where that branch went, unless GitHub
    // already did so when the branch was deleted.
    const parent = step.after.map((id) => merged.get(id)).find((other) => other?.head === pullRequest.base)
    if (parent) await github.setPullRequestBase(repo, number, parent.base)
    // Right after a merge GitHub may still report whether it could be merged before.
    if (merged.size) await sleep(pollMs)
    pullRequest = await fetchSettled(repo, number)

    if (pullRequest.merged) return { status: 'merged' as const, message: 'Already merged', pullRequest }
    if (step.headSha && pullRequest.headSha !== step.headSha) {
      return {
        status: 'skipped' as const,
        message: 'Got new commits after merging started; look at them, then merge it again',
      }
    }
    const reason = skipReason(pullRequest)
    if (reason) {
      const conflicts = pullRequest.mergeable === false && !pullRequest.draft && pullRequest.state === 'open'
      return { status: 'skipped' as const, message: conflicts ? `${reason}; its agent can resolve them` : reason }
    }
    await github.mergePullRequest(repo, number, { method: run.method, sha: pullRequest.headSha })
    return { status: 'merged' as const, message: null, pullRequest }
  }

  async function execute(run: MergeRun) {
    const merged = new Map<string, GitHubPullRequest>()
    const numberOf = (ticketId: string) => run.steps.find((step) => step.ticketId === ticketId)?.ticketNumber
    try {
      for (const step of run.steps) {
        if (step.status !== 'pending') continue
        const missing = step.after.find((id) => !merged.has(id))
        if (missing) {
          Object.assign(step, { status: 'skipped', message: `Builds on #${numberOf(missing)}, which wasn't merged` })
          continue
        }
        step.status = 'merging'
        try {
          const result = await mergeStep(run, step, merged)
          Object.assign(step, { status: result.status, message: result.message })
          if (result.status === 'merged') {
            merged.set(step.ticketId, result.pullRequest)
            // Moves the ticket to the done column right away rather than at the next poll.
            await pullRequests.syncTicket(step.ticketId).catch(() => null)
          }
        } catch (error) {
          Object.assign(step, { status: 'failed', message: errorMessage(error) })
        }
      }
    } finally {
      run.status = 'finished'
      run.finishedAt = now()
    }
  }

  return {
    plan,

    /** The board's latest run, if there was one since the server started. */
    latest: (boardId: string) => runs.get(boardId) ?? null,

    /** Plans the merges now and starts merging in the background; follow along with `latest`. */
    async start(boardId: string, method: MergeMethod, actor: string) {
      const current = runs.get(boardId)
      if (starting.has(boardId) || current?.status === 'running') {
        throw conflict('merge_in_progress', "This board's pull requests are already being merged", { run: current })
      }
      starting.add(boardId)
      try {
        const { items } = await plan(boardId)
        const run: MergeRun = {
          id: newId(),
          boardId,
          actor,
          method,
          status: 'running',
          startedAt: now(),
          finishedAt: null,
          steps: items.map((item) => ({ ...item, status: item.skip ? 'skipped' : 'pending', message: item.skip })),
        }
        runs.set(boardId, run)
        void execute(run)
        return run
      } finally {
        starting.delete(boardId)
      }
    },
  }
}
