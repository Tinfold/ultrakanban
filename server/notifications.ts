import type { Ticket, TicketBudget } from '../shared/domain.ts'
import { now, sql } from './db.ts'
import { getBoard } from './store/boards.ts'

/**
 * Why a ticket needs a person: its agent asked something (`question`), someone has to look at it, e.g. CI that
 * didn't run properly (`attention`), its agent's plan waits for approval (`approval`), a question ticket was answered
 * (`answer`), its pull request is ready to merge (`ready`), or its agent runs used up its budget (`budget`).
 */
export type NotificationKind = 'question' | 'attention' | 'approval' | 'answer' | 'ready' | 'budget'

export interface Notification {
  kind: NotificationKind
  boardId: string
  boardName: string
  ticketId: string
  ticketNumber: number
  ticketTitle: string
  /** One line, e.g. `#12 needs an answer: Add dark mode`. */
  title: string
  message: string
  /** Where to look: the ticket on the board when `ULTRAKANBAN_URL` is set, otherwise its pull request, if any. */
  url: string | null
}

/** Delivers a notification to a board's `notifyUrl`. */
export type SendNotification = (target: string, notification: Notification) => Promise<void>

const HEADLINES: Record<NotificationKind, string> = {
  question: 'needs an answer',
  attention: 'needs someone',
  approval: 'waits for approval of its plan',
  answer: 'was answered',
  ready: 'is ready to merge',
  budget: 'used up its budget',
}

const NTFY_TAGS: Partial<Record<NotificationKind, string>> = { ready: 'white_check_mark', budget: 'money_with_wings' }

const usd = (amount: number) => `$${amount.toFixed(2)}`

/**
 * What a `budget` notification says: what the ticket's runs cost against which budget, and how to let its agent go on.
 * `own` is whether the budget is the ticket's own rather than its board's default.
 */
export function budgetMessage(budget: TicketBudget, own: boolean) {
  const cap = own ? `its ${usd(budget.limitUsd)} budget` : `the board's budget of ${usd(budget.limitUsd)} per ticket`
  return (
    `Its agent runs have cost an estimated ${usd(budget.spentUsd)}, which uses up ${cap}, so its agent starts no ` +
    `more runs on it. Raise or clear the budget to let the agent carry on.`
  )
}

const isDiscord = (url: URL) =>
  /(^|\.)discord(app)?\.com$/.test(url.hostname) && url.pathname.startsWith('/api/webhooks/')

/** ntfy.sh, or a server of its own named like it (e.g. ntfy.example.com). */
const isNtfy = (url: URL) => /(^|\.)ntfy(\.|$)/.test(url.hostname)

/**
 * Posts a notification in the target's format: a Discord message for a Discord webhook, a plain message with its
 * title and link as query parameters for ntfy, and the notification as JSON for any other URL.
 */
export async function sendNotification(target: string, notification: Notification) {
  const url = new URL(target)
  const { title, message, url: link } = notification
  let body: string
  let contentType = 'application/json'
  if (isDiscord(url)) {
    body = JSON.stringify({ content: [`**${title}**`, message, link].filter(Boolean).join('\n').slice(0, 2000) })
  } else if (isNtfy(url)) {
    // Query parameters rather than headers, which can't carry non-ASCII text such as an emoji in a ticket title.
    url.searchParams.set('title', title)
    url.searchParams.set('tags', NTFY_TAGS[notification.kind] ?? 'raising_hand')
    if (link) url.searchParams.set('click', link)
    body = message
    contentType = 'text/plain; charset=utf-8'
  } else {
    body = JSON.stringify(notification)
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`${url.origin} responded ${response.status}`)
}

export type Notifier = ReturnType<typeof createNotifier>

/** Sends boards' notifications, each one only once. */
export function createNotifier(send: SendNotification = sendNotification, publicUrl = process.env.ULTRAKANBAN_URL) {
  return {
    /**
     * Tells the ticket's board that the ticket needs a person, unless the board has no `notifyUrl` or it was already
     * told about `key` (e.g. the comment or commit it is about). Sends in the background; returns whether it sends.
     */
    notify(ticket: Ticket, kind: NotificationKind, key: string, message: string) {
      const board = getBoard(ticket.boardId)
      if (!board.notifyUrl) return false
      const { changes } = sql.run(
        'INSERT OR IGNORE INTO notifications (ticket_id, key, kind, created_at) VALUES (?, ?, ?, ?)',
        ticket.id,
        key,
        kind,
        now(),
      )
      if (!changes) return false
      const notification: Notification = {
        kind,
        boardId: board.id,
        boardName: board.name,
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        ticketTitle: ticket.title,
        title: `#${ticket.number} ${HEADLINES[kind]}: ${ticket.title}`,
        message,
        url: publicUrl
          ? `${publicUrl.replace(/\/+$/, '')}/b/${board.id}?ticket=${ticket.id}`
          : (ticket.pullRequest?.url ?? null),
      }
      send(board.notifyUrl, notification).catch((error: unknown) =>
        console.warn(`Notification for ticket ${ticket.id} failed: ${error instanceof Error ? error.message : error}`),
      )
      return true
    },
  }
}
