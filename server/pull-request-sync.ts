import { parsePullRequestUrl, type Ticket } from '../shared/domain.ts'
import { transaction } from './db.ts'
import type { GitHubClient } from './github.ts'
import { getBoard } from './store/boards.ts'
import { applyPullRequestStatus, getTicket, listPendingPullRequests } from './store/tickets.ts'

export type PullRequestSync = ReturnType<typeof createPullRequestSync>

/**
 * Keeps tickets' pull request states in sync with GitHub, moving merged tickets to the done column and, on boards with
 * `deleteMergedBranches`, deleting their branches.
 */
export function createPullRequestSync(github: GitHubClient) {
  let running: Promise<void> | null = null

  /**
   * Deletes a merged pull request's branch, unless it is in a fork, is the default branch or got commits after the
   * merge. The open pull requests based on it move to its base first, so they stay open.
   */
  async function deleteBranch(url: string) {
    const { repo, number } = parsePullRequestUrl(url)!
    const pullRequest = await github.getPullRequest(repo, number)
    if (!pullRequest.merged || pullRequest.headRepo?.toLowerCase() !== repo.toLowerCase()) return
    if (pullRequest.head === (await github.defaultBranch(repo))) return
    if ((await github.branchSha(repo, pullRequest.head)) !== pullRequest.headSha) return
    for (const stacked of await github.listPullRequestsInto(repo, pullRequest.head)) {
      await github.setPullRequestBase(repo, stacked, pullRequest.base)
    }
    await github.deleteBranch(repo, pullRequest.head)
  }

  async function sync(ticketId: string, url: string) {
    try {
      const status = await github.fetchPullRequestStatus(url)
      const wasMerged = getTicket(ticketId).pullRequest?.state === 'merged'
      const ticket = transaction(() => applyPullRequestStatus(ticketId, url, status))
      if (!wasMerged && ticket.pullRequest?.state === 'merged' && getBoard(ticket.boardId).deleteMergedBranches) {
        await deleteBranch(url).catch((error: unknown) =>
          console.warn(`Deleting the branch of ticket ${ticketId}'s pull request failed: ${(error as Error).message}`),
        )
      }
      return ticket
    } catch (error) {
      console.warn(`Pull request sync failed for ticket ${ticketId}: ${(error as Error).message}`)
      return null
    }
  }

  const syncAll = () =>
    (running ??= (async () => {
      for (const { ticketId, url } of listPendingPullRequests()) await sync(ticketId, url)
    })().finally(() => (running = null)))

  /** Checks one ticket's pull request now; returns the (possibly updated) ticket. */
  async function syncTicket(ticketId: string) {
    const url = getTicket(ticketId).pullRequest?.url
    if (url) await sync(ticketId, url)
    return getTicket(ticketId)
  }

  return {
    github,
    syncTicket,

    /** Checks every pending pull request; overlapping calls share one run. */
    syncAll,

    /** Checks a newly linked pull request in the background, so its state shows up without waiting for polling. */
    checkSoon(ticket: Ticket) {
      if (ticket.pullRequest?.state === 'unknown') void syncTicket(ticket.id)
    },

    start(intervalMs: number) {
      void syncAll()
      setInterval(() => void syncAll(), intervalMs).unref()
    },
  }
}
