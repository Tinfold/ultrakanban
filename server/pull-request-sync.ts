import type { Ticket } from '../shared/domain.ts'
import { transaction } from './db.ts'
import type { GitHubClient } from './github.ts'
import { applyPullRequestStatus, getTicket, listPendingPullRequests } from './store/tickets.ts'

export type PullRequestSync = ReturnType<typeof createPullRequestSync>

/** Keeps tickets' pull request states in sync with GitHub, moving merged tickets to the done column. */
export function createPullRequestSync(github: GitHubClient) {
  let running: Promise<void> | null = null

  async function sync(ticketId: string, url: string) {
    try {
      const status = await github.fetchPullRequestStatus(url)
      return transaction(() => applyPullRequestStatus(ticketId, url, status))
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
