import {
  isBillingFailure,
  MERGE_METHODS,
  type MergeMethod,
  type MergePlan,
  type MergePlanItem,
  type MergeRun,
  type MergeRunStep,
  parseLocalPullRequestUrl,
  type Ticket,
} from '../shared/domain.ts'
import { parseChecklist } from '../shared/checklist.ts'
import { failsOnlyForBilling } from './checks.ts'
import { newId, now } from './db.ts'
import { badRequest, conflict, HttpError } from './errors.ts'
import type { GitHubPullRequest } from './github.ts'
import type { Notifier } from './notifications.ts'
import type { PullRequestSync } from './pull-request-sync.ts'
import { type AutoMergeFinding, setAutoMergeWaits } from './store/auto-merge.ts'
import { getBoard, listBoards } from './store/boards.ts'
import { getTicket, listTickets, pullRequestChecks } from './store/tickets.ts'

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

/** `1 checklist item`, `2 checklist items`. */
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Names for people: the first few, and how many more. */
const someNames = (names: string[]) =>
  names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')

/**
 * Why auto-merge can't merge a ticket's pull request, going by what the board knows without asking GitHub (see
 * `mergeCandidates`): it is a draft, has conflicts, or its ticket's checklist isn't done. Null when it could be ready.
 * The same reasons, in the same order, as `autoMerge` gives once it asks GitHub.
 */
function knownWait(ticket: Ticket): AutoMergeFinding {
  if (ticket.pullRequest?.state === 'draft') return { reason: 'Still a draft', failed: false }
  if (ticket.pullRequest?.conflicts) return { reason: 'Merge conflicts', failed: false }
  const unchecked = parseChecklist(ticket.description).filter((item) => !item.checked).length
  if (unchecked) return { reason: `${counted(unchecked, 'checklist item')} unchecked`, failed: false }
  return null
}

/** What the board last read of the ticket's checks, as a reason to wait: failing ones by name, or running ones. */
function checksWait(ticket: Ticket) {
  const pullRequest = ticket.pullRequest
  if (pullRequest?.checks === 'failing') {
    const names = pullRequest.failingChecks.map((check) => check.name)
    return names.length ? `Checks failing: ${someNames(names)}` : 'Checks failing'
  }
  return pullRequest?.checks === 'pending' ? 'Waiting for checks' : null
}

/**
 * Why GitHub doesn't find a pull request ready to merge (see `readyToMerge`), for people. GitHub only says that branch
 * protection blocks it, so the checks the board knows of tell whether it waits for them; otherwise it most likely
 * waits for a required review.
 */
function notReadyReason(pullRequest: GitHubPullRequest, ticket: Ticket) {
  if (pullRequest.mergeable === null || pullRequest.mergeableState === 'unknown') {
    return 'GitHub is still working out whether it can be merged'
  }
  switch (pullRequest.mergeableState) {
    case 'blocked':
      return checksWait(ticket) ?? 'Branch protection blocks it, e.g. it needs an approving review'
    case 'behind':
      return `Behind ${pullRequest.base}, and branch protection needs it up to date`
    case 'unstable':
      return checksWait(ticket) ?? 'Some checks are not passing'
    case 'dirty':
      return 'Merge conflicts'
    case 'draft':
      return 'Still a draft'
    default:
      return `GitHub doesn't find it ready to merge (${pullRequest.mergeableState})`
  }
}

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

  /**
   * Whether the board lets a pull request merge despite its failing checks (see `BoardSummary.ignoreBillingFailures`):
   * it has no conflicts, GitHub holds it back only as `unstable` or `blocked`, which failing checks make it, and every
   * check failed for billing, as the board last read them and as they are now. Reading them again makes sure they are
   * the head commit's and none is still running. Branch protection may still refuse the merge (a required review).
   */
  async function onlyBillingFails(ticket: Ticket, pullRequest: GitHubPullRequest | null) {
    const known = ticket.pullRequest
    if (!known || !pullRequest || !getBoard(ticket.boardId).ignoreBillingFailures) return false
    if (pullRequest.state !== 'open' || pullRequest.draft || pullRequest.mergeable !== true) return false
    if (!['unstable', 'blocked'].includes(pullRequest.mergeableState)) return false
    if (known.checks !== 'failing' || !known.failingChecks.every((check) => isBillingFailure(check))) return false
    return failsOnlyForBilling(github, known.repo, pullRequest.headSha, pullRequestChecks(ticket.id)).catch(() => false)
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
    if (parseLocalPullRequestUrl(url)) {
      item.skip = 'A local pull request: merge it on its page'
      return { item, index, pullRequest: null, files: new Set() }
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
      throw badRequest('Merging needs a GitHub token: add one on the Setup page (/setup), or set GITHUB_TOKEN')
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
   * Why auto-merge won't merge an item of the plan this round, given the items found ready before it in merge order;
   * null when it is ready. In the order the board can tell without GitHub (see `knownWait`), then what GitHub says
   * (which `billingOnly`, see `onlyBillingFails`, overrules), then the pull requests it builds on.
   */
  function waitFor(
    item: MergePlanItem,
    pullRequest: GitHubPullRequest | null,
    ticket: Ticket,
    byTicket: Map<string, MergePlanItem>,
    ready: Set<string>,
    billingOnly: boolean,
  ): AutoMergeFinding {
    if (item.skip) {
      // It couldn't be read from GitHub: auto-merge itself failed.
      if (!pullRequest) return { reason: item.skip, failed: true }
      const own = skipReason(pullRequest)
      if (!own) {
        const parent = item.after.map((id) => byTicket.get(id)).find((other) => other?.skip)
        return { reason: `Waits for #${parent?.ticketNumber}, which can't be merged yet`, failed: false }
      }
      return { reason: pullRequest.mergeable === false && !pullRequest.draft ? 'Merge conflicts' : own, failed: false }
    }
    if (!checklistDone(ticket)) return knownWait(ticket)
    if (!pullRequest || !(readyToMerge(pullRequest) || billingOnly)) {
      return { reason: pullRequest ? notReadyReason(pullRequest, ticket) : 'Not found on GitHub', failed: false }
    }
    const waiting = item.after.find((id) => !ready.has(id))
    if (waiting) return { reason: `Waits for #${byTicket.get(waiting)?.ticketNumber} to merge first`, failed: false }
    return null
  }

  /**
   * Merges the board's pull requests that are ready: in the review column, open, not a draft, without conflicts,
   * with every check passed (or failed only for billing, on boards that ignore that) and every checklist item of their
   * ticket checked, and building only on others that are ready too. Returns the run, or null when none were ready (or another run is going), without starting one.
   *
   * Each round also records why each of the review column's pull requests isn't merged (see `AutoMergeWait`): what
   * keeps it from being ready, or that merging it failed, including when the round itself couldn't run. A ready one
   * whose merge failed before keeps that failure until this round's merge says otherwise, so a merge that keeps failing
   * shows.
   */
  async function autoMerge(boardId: string) {
    const tickets = reviewTickets(boardId)
    const findings = new Map<string, AutoMergeFinding>(tickets.map((ticket) => [ticket.id, knownWait(ticket)]))
    // Asks GitHub only when a ticket could be ready: most of the time none is.
    if (tickets.every((ticket) => findings.get(ticket.id))) {
      setAutoMergeWaits(boardId, findings)
      return null
    }
    const current = runs.get(boardId)
    if (starting.has(boardId) || current?.status === 'running') return null

    return exclusive(boardId, async () => {
      let planned: Awaited<ReturnType<typeof planEntries>>
      try {
        planned = await planEntries(boardId)
      } catch (error) {
        for (const ticket of tickets) {
          if (findings.get(ticket.id)) continue
          findings.set(ticket.id, { reason: `Auto-merge couldn't run: ${errorMessage(error)}`, failed: true })
        }
        setAutoMergeWaits(boardId, findings)
        throw error
      }
      const { items, methods, pullRequestOf } = planned
      const byTicket = new Map(items.map((item) => [item.ticketId, item]))
      const ready = new Set<string>()
      findings.clear()
      for (const item of items) {
        // The plan lists local pull requests too, as ones "merge all" skips; auto-merge leaves them out altogether.
        if (parseLocalPullRequestUrl(item.url)) continue
        const ticket = getTicket(item.ticketId)
        const pullRequest = pullRequestOf.get(item.ticketId) ?? null
        const billingOnly = !item.skip && checklistDone(ticket) && (await onlyBillingFails(ticket, pullRequest))
        const wait = waitFor(item, pullRequest, ticket, byTicket, ready, billingOnly)
        if (wait) {
          findings.set(item.ticketId, wait)
          continue
        }
        ready.add(item.ticketId)
        const failure = ticket.autoMergeWait?.failed ? ticket.autoMergeWait : null
        findings.set(item.ticketId, failure && { reason: failure.reason, failed: true })
      }
      setAutoMergeWaits(boardId, findings)
      if (!ready.size) return null
      const run = newRun(
        boardId,
        methods[0] ?? 'merge',
        AUTO_MERGE_ACTOR,
        items.filter((item) => ready.has(item.ticketId)),
      )
      await execute(run)
      for (const step of run.steps) {
        if (step.status === 'merged') findings.set(step.ticketId, null)
        else if (step.status === 'failed') {
          const reason = `Merging failed: ${step.message ?? 'GitHub turned it down'}`
          findings.set(step.ticketId, { reason, failed: true })
        } else if (step.status === 'skipped') {
          findings.set(step.ticketId, { reason: step.message ?? 'Skipped this round', failed: false })
        }
      }
      setAutoMergeWaits(boardId, findings)
      return run
    })
  }

  /**
   * The review column's tickets with a GitHub pull request that isn't merged or closed, going by what the board knows.
   * Local pull requests aren't on GitHub, and are merged only on their page.
   */
  function reviewTickets(boardId: string) {
    const reviewColumnId = getBoard(boardId).reviewColumnId
    if (!reviewColumnId) return []
    return listTickets(boardId, { column: reviewColumnId }).filter(
      (ticket) =>
        ticket.pullRequest &&
        !parseLocalPullRequestUrl(ticket.pullRequest.url) &&
        !['merged', 'closed'].includes(ticket.pullRequest.state),
    )
  }

  /** The review column's tickets whose pull request could be ready to merge, going by what the board knows. */
  function mergeCandidates(boardId: string) {
    return reviewTickets(boardId).filter((ticket) => !ticket.pullRequest!.conflicts && checklistDone(ticket))
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
      if (!pullRequest) continue
      const passed = readyToMerge(pullRequest)
      if (!passed && !(await onlyBillingFails(ticket, pullRequest))) continue
      const checks = passed ? 'every check passed' : 'its only failing checks failed because of billing'
      const message = `${pullRequest.title}: ${checks} and it has no conflicts. ${url}`
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
        continue
      }
      // With auto-merge off, none of its tickets wait for it.
      setAutoMergeWaits(board.id, new Map())
      if (board.notifyUrl && notifier) {
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
