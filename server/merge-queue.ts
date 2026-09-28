import {
  MERGE_METHODS,
  type MergeMethod,
  type MergePlan,
  type MergePlanItem,
  type MergeRun,
  type MergeRunStep,
  type Ticket,
} from '../shared/domain.ts'
import { parseChecklist } from '../shared/checklist.ts'
import { newId, now } from './db.ts'
import { badRequest, conflict, HttpError } from './errors.ts'
import type { GitHubPullRequest } from './github.ts'
import type { Notifier } from './notifications.ts'
import type { PullRequestSync } from './pull-request-sync.ts'
import { getBoard, listBoards } from './store/boards.ts'
import { getTicket, listTickets } from './store/tickets.ts'

export interface MergeQueueOptions {
  /** Wait between checks while GitHub works out whether a pull request can be merged, and after each merge. */
  pollMs?: number
  /** Checks before going ahead without GitHub's answer. */
  maxPolls?: number
  /** Tells boards without auto-merge when a pull request is ready to merge. */
  notifier?: Notifier
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

/** Actor of the runs that merge boards' pull requests by themselves (the board's `autoMerge` setting). */
export const AUTO_MERGE_ACTOR = 'auto-merge'

/** Whether every step of the ticket's checklist is checked (true when it has none). */
const checklistDone = (ticket: Ticket) => parseChecklist(ticket.description).every((item) => item.checked)

/** Whether a pull request is ready to merge without anyone looking: no conflicts and every check passed. */
const readyToMerge = (pullRequest: GitHubPullRequest | null) =>
  pullRequest?.state === 'open' &&
  !pullRequest.draft &&
  pullRequest.mergeable === true &&
  ['clean', 'has_hooks'].includes(pullRequest.mergeableState)

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
  { pollMs = 2000, maxPolls = 15, notifier }: MergeQueueOptions = {},
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

  /**
   * With `focus`, only that ticket's pull request is compared with the others, which is all merging it on its own
   * needs to know.
   */
  async function plan(boardId: string, focus?: string): Promise<MergePlan> {
    const { items, methods } = await planEntries(boardId, focus)
    return { items, methods }
  }

  /** `plan`, along with each pull request as GitHub reported it (`null` if it couldn't be read). */
  async function planEntries(boardId: string, focus?: string) {
    const reviewColumnId = getBoard(boardId).reviewColumnId
    if (!reviewColumnId) throw badRequest('This board has no review column; choose one in the board settings')
    if (!(await github.auth())) {
      throw badRequest('Merging needs a GitHub token: set GITHUB_TOKEN or log in with the GitHub CLI (gh auth login)')
    }
    const tickets = listTickets(boardId, { column: reviewColumnId }).filter(
      (ticket) => ticket.pullRequest && !['merged', 'closed'].includes(ticket.pullRequest.state),
    )
    const entries = await Promise.all(tickets.map(describe))

    const pairs = entries
      .flatMap((a, i) => entries.slice(i + 1).map((b) => [a, b] as const))
      .filter((pair) => !focus || pair.some((entry) => entry.item.ticketId === focus))
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

    const pullRequestOf = new Map(entries.map((entry) => [entry.item.ticketId, entry.pullRequest]))
    const ordered = mergeOrder(entries).map((entry) => entry.item)
    const byTicket = new Map(ordered.map((item) => [item.ticketId, item]))
    for (const item of ordered) {
      const blocked = item.after.map((id) => byTicket.get(id)!).find((parent) => parent.skip)
      item.skip ??= blocked ? `Builds on #${blocked.ticketNumber}, which won't be merged` : null
    }

    const repos = [...new Set(ordered.filter((item) => !item.skip).map((item) => item.repo))]
    const allowed = await Promise.all(repos.map((repo) => github.mergeMethods(repo).catch(() => [...MERGE_METHODS])))
    const methods = MERGE_METHODS.filter((method) => allowed.every((repoMethods) => repoMethods.includes(method)))
    return { items: ordered, methods, pullRequestOf }
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

  function newRun(boardId: string, method: MergeMethod, actor: string, items: MergePlanItem[]): MergeRun {
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
    return run
  }

  /** Makes sure only one run, or single merge, per board is planned or merging at a time. */
  async function exclusive<T>(boardId: string, work: () => Promise<T>) {
    const current = runs.get(boardId)
    if (starting.has(boardId) || current?.status === 'running') {
      throw conflict('merge_in_progress', "This board's pull requests are already being merged", { run: current })
    }
    starting.add(boardId)
    try {
      return await work()
    } finally {
      starting.delete(boardId)
    }
  }

  /**
   * Merges the board's pull requests that are ready: in the review column, open, not a draft, without conflicts,
   * with every check passed and every checklist item of their ticket checked, and building only on others that are
   * ready too. Returns the run, or null when none were ready (or another run is going), without starting one.
   */
  async function autoMerge(boardId: string) {
    // Asks GitHub only when a ticket could be ready: most of the time none is.
    if (!mergeCandidates(boardId).length) return null
    const current = runs.get(boardId)
    if (starting.has(boardId) || current?.status === 'running') return null

    return exclusive(boardId, async () => {
      const { items, methods, pullRequestOf } = await planEntries(boardId)
      const ready = new Set<string>()
      for (const item of items) {
        if (item.skip || !readyToMerge(pullRequestOf.get(item.ticketId) ?? null)) continue
        if (!checklistDone(getTicket(item.ticketId))) continue
        if (item.after.every((id) => ready.has(id))) ready.add(item.ticketId)
      }
      if (!ready.size) return null
      const run = newRun(
        boardId,
        methods[0] ?? 'merge',
        AUTO_MERGE_ACTOR,
        items.filter((item) => ready.has(item.ticketId)),
      )
      await execute(run)
      return run
    })
  }

  /** The review column's tickets whose pull request could be ready to merge, going by what the board knows. */
  function mergeCandidates(boardId: string) {
    const reviewColumnId = getBoard(boardId).reviewColumnId
    if (!reviewColumnId) return []
    return listTickets(boardId, { column: reviewColumnId }).filter(
      (ticket) =>
        ticket.pullRequest &&
        !['merged', 'closed'].includes(ticket.pullRequest.state) &&
        !ticket.pullRequest.conflicts &&
        checklistDone(ticket),
    )
  }

  /**
   * Notifies the board of each pull request in its review column that is ready to merge (see `autoMerge`), once
   * per commit. Returns the tickets it notified about.
   */
  async function notifyReady(boardId: string) {
    const notified: Ticket[] = []
    for (const ticket of mergeCandidates(boardId)) {
      const { repo, number, url } = ticket.pullRequest!
      const pullRequest = await github.getPullRequest(repo, number).catch(() => null)
      if (!pullRequest || !readyToMerge(pullRequest)) continue
      const message = `${pullRequest.title}: every check passed and it has no conflicts. ${url}`
      if (notifier?.notify(ticket, 'ready', `ready:${pullRequest.headSha}`, message)) notified.push(ticket)
    }
    return notified
  }

  /**
   * Runs `autoMerge` on every board that has it switched on, and `notifyReady` on the other boards that send
   * notifications, one board at a time.
   */
  async function autoMergeAll() {
    for (const board of listBoards()) {
      if (board.autoMerge) {
        await autoMerge(board.id).catch((error) =>
          console.warn(`Auto-merge failed for board ${board.id}: ${errorMessage(error)}`),
        )
      } else if (board.notifyUrl && notifier) {
        await notifyReady(board.id).catch((error) =>
          console.warn(`Checking for ready pull requests failed for board ${board.id}: ${errorMessage(error)}`),
        )
      }
    }
  }

  return {
    plan,
    autoMerge,
    notifyReady,
    autoMergeAll,

    /** Runs `autoMergeAll` now and then every `intervalMs`, never two at once. */
    startAutoMerge(intervalMs: number) {
      let running: Promise<void> | null = null
      const tick = () => void (running ??= autoMergeAll().finally(() => (running = null)))
      tick()
      setInterval(tick, intervalMs).unref()
    },

    /** The board's latest run, if there was one since the server started. */
    latest: (boardId: string) => runs.get(boardId) ?? null,

    /** Plans the merges now and starts merging in the background; follow along with `latest`. */
    start: (boardId: string, method: MergeMethod, actor: string) =>
      exclusive(boardId, async () => {
        const { items } = await plan(boardId)
        const run = newRun(boardId, method, actor, items)
        void execute(run)
        return run
      }),

    /**
     * Merges one ticket's pull request now, as a run of its own so it never overlaps "merge all". Refuses one that
     * builds on another pull request still in review: merging it first would merge the other's changes with it.
     * Uses `method` if the repository allows it, otherwise the first method it does. Returns the updated ticket.
     */
    mergeTicket: (ticketId: string, method: MergeMethod | undefined, actor: string) => {
      const { boardId } = getTicket(ticketId)
      return exclusive(boardId, async () => {
        const { items } = await plan(boardId, ticketId)
        const item = items.find((other) => other.ticketId === ticketId)
        if (!item) throw badRequest('Only tickets in the review column with an open pull request can be merged')
        const parent = items.find((other) => item.after.includes(other.ticketId))
        if (!item.skip && parent) {
          item.skip = `Builds on the pull request of #${parent.ticketNumber}; merge that one first, or merge all`
        }
        if (item.skip) throw conflict('cannot_merge', item.skip)

        const allowed = await github.mergeMethods(item.repo).catch(() => [...MERGE_METHODS])
        const chosen = method && allowed.includes(method) ? method : (allowed[0] ?? 'merge')
        const run = newRun(boardId, chosen, actor, [item])
        await execute(run)
        const [step] = run.steps
        if (step.status === 'skipped') throw conflict('cannot_merge', step.message ?? "Couldn't merge it")
        if (step.status !== 'merged') throw new HttpError(502, 'github_error', step.message ?? "Couldn't merge it")
        return getTicket(ticketId)
      })
    },
  }
}
