import {
  type Activity,
  AGENT_EFFORTS,
  agentWorkerName,
  type Overview,
  type OverviewActivity,
  type OverviewAgent,
  type OverviewBoard,
  type OverviewEventKind,
  type OverviewRange,
  type OverviewTicket,
  type PullRequestState,
  type WorkSession,
  type WorkState,
} from '../../shared/domain.ts'
import { sql } from '../db.ts'
import { type ActivityRow, toActivity } from './activity.ts'
import { listBoards } from './boards.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const RECENT_LIMIT = 30

interface TicketRow {
  id: string
  board_id: string
  column_id: string
  number: number
  title: string
  assignee: string | null
  pr_url: string | null
  pr_state: string
  created_at: string
}

interface ColumnRow {
  id: string
  board_id: string
  name: string
}

/** A board's review and done columns. Activity records column names, so they're matched by (lowercased) name too. */
interface Workflow {
  reviewId: string | null
  doneId: string | null
  reviewName: string | null
  doneName: string | null
}

const key = (name: string) => name.toLowerCase()

/** Where agents release tickets whose pull request was closed without merging (see scripts/agent-loop.sh). */
const CANCELLED = 'cancelled'

/** Whether nobody works on a ticket anymore: it's done or cancelled, or its pull request was closed unmerged. */
function isClosed(workflow: Workflow, column: string, pullRequestClosed: boolean) {
  return pullRequestClosed || column === workflow.doneName || column === CANCELLED
}

/** Where a ticket stands for its assignee, given the column it's in and whether its pull request was closed. */
function workState(
  workflow: Workflow,
  column: string | null,
  assignee: string | null,
  pullRequestClosed: boolean,
): WorkState | null {
  if (!assignee || column === null || isClosed(workflow, column, pullRequestClosed)) return null
  return column === workflow.reviewName ? 'review' : 'working'
}

/**
 * Aggregates activity across all boards over the last `days` days: who is working on what, how long agents
 * worked, and what happened when. Work time is reconstructed from the activity log (claims, releases and moves).
 */
export function getOverview(days: OverviewRange, at = new Date()): Overview {
  const generatedAt = at.toISOString()
  const since = new Date(at.getTime() - days * DAY_MS).toISOString()

  const boards = listBoards()
  const boardNames = new Map(boards.map((board) => [board.id, board.name]))
  const columns = sql.all<ColumnRow>('SELECT id, board_id, name FROM columns ORDER BY board_id, position')
  const columnNames = new Map(columns.map((column) => [column.id, column.name]))
  const workflows = new Map<string, Workflow>()
  for (const board of boards) {
    // Without a done column, a board's last column is where finished work goes.
    const doneId = board.doneColumnId ?? columns.findLast((column) => column.board_id === board.id)?.id ?? null
    const reviewId = board.reviewColumnId
    workflows.set(board.id, {
      reviewId,
      doneId,
      reviewName: reviewId ? key(columnNames.get(reviewId)!) : null,
      doneName: doneId ? key(columnNames.get(doneId)!) : null,
    })
  }

  const tickets = sql.all<TicketRow>(
    'SELECT id, board_id, column_id, number, title, assignee, pr_url, pr_state, created_at FROM tickets',
  )
  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]))

  // Replay the history of every ticket that changed within the range or is assigned now.
  const history = sql.all<ActivityRow>(
    `SELECT * FROM activity
     WHERE type IN ('created', 'moved', 'claimed', 'released', 'pull_request')
       AND ticket_id IN (SELECT ticket_id FROM activity WHERE created_at >= ? UNION SELECT id FROM tickets WHERE assignee IS NOT NULL)
     ORDER BY ticket_id, id`,
    since,
  )
  const sessions: WorkSession[] = []
  const completedBy = new Map<string, number>()
  const completedOn = new Map<string, number>()
  /** When each ticket entered its current state. */
  const stateSince = new Map<string, string>()
  const increment = (counts: Map<string, number>, name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)

  for (let i = 0; i < history.length;) {
    const ticket = ticketsById.get(history[i].ticket_id)!
    const workflow = workflows.get(ticket.board_id)!
    const entries: Activity[] = []
    while (i < history.length && history[i].ticket_id === ticket.id) entries.push(toActivity(history[i++]))

    // Tickets created with an assignee have no claim to replay; start from their assignee.
    let assignee = entries.some((entry) => entry.type === 'claimed' || entry.type === 'released')
      ? null
      : ticket.assignee
    let column: string | null = null
    let pullRequestClosed = false
    let state: WorkState | null = null
    let session: WorkSession | null = null
    for (const entry of entries) {
      if (entry.type === 'created') column = key(entry.data.column)
      if (entry.type === 'moved') {
        column = key(entry.data.to)
        if (column === workflow.doneName && entry.createdAt >= since) {
          increment(completedOn, ticket.board_id)
          if (assignee) increment(completedBy, assignee)
        }
      }
      if (entry.type === 'claimed') assignee = entry.data.assignee
      if (entry.type === 'released') assignee = null
      // Linking another pull request or reopening this one resumes the work.
      if (entry.type === 'pull_request') pullRequestClosed = entry.data.event === 'closed'

      const previous: WorkState | null = state
      state = workState(workflow, column, assignee, pullRequestClosed)
      const worker = state === 'working' ? assignee : null
      if (session && session.agent !== worker) {
        session.end = entry.createdAt
        session = null
      }
      if (worker && !session) {
        session = { agent: worker, ticketId: ticket.id, boardId: ticket.board_id, start: entry.createdAt, end: null }
        sessions.push(session)
      }
      // Pull request updates don't move the ticket, so only count when they change its state.
      if (entry.type !== 'pull_request' || state !== previous) stateSince.set(ticket.id, entry.createdAt)
    }
  }

  const clipped = sessions
    .filter((session) => (session.end ?? generatedAt) > since)
    .map((session) => ({ ...session, start: session.start < since ? since : session.start }))
  const workedMs = new Map<string, number>()
  for (const session of clipped) {
    const duration = Date.parse(session.end ?? generatedAt) - Date.parse(session.start)
    workedMs.set(session.agent, (workedMs.get(session.agent) ?? 0) + duration)
  }

  // What everyone holds right now.
  const holdings = new Map<string, OverviewTicket[]>()
  const boardCounts = new Map<string, { open: number; working: number; review: number }>()
  for (const ticket of tickets) {
    const workflow = workflows.get(ticket.board_id)!
    const counts = boardCounts.get(ticket.board_id) ?? { open: 0, working: 0, review: 0 }
    boardCounts.set(ticket.board_id, counts)
    if (isClosed(workflow, key(columnNames.get(ticket.column_id)!), ticket.pr_state === 'closed')) continue
    counts.open++
    if (!ticket.assignee) continue
    const state: WorkState = ticket.column_id === workflow.reviewId ? 'review' : 'working'
    counts[state]++
    const held = holdings.get(ticket.assignee) ?? []
    holdings.set(ticket.assignee, held)
    held.push({
      id: ticket.id,
      boardId: ticket.board_id,
      boardName: boardNames.get(ticket.board_id)!,
      number: ticket.number,
      title: ticket.title,
      column: columnNames.get(ticket.column_id)!,
      state,
      since: stateSince.get(ticket.id) ?? ticket.created_at,
      pullRequest: ticket.pr_url ? { url: ticket.pr_url, state: ticket.pr_state as PullRequestState } : null,
    })
  }

  const eventRows = sql.all<ActivityRow & { board_id: string }>(
    `SELECT a.*, t.board_id FROM activity a JOIN tickets t ON t.id = a.ticket_id
     WHERE a.created_at >= ? ORDER BY a.created_at, a.id`,
    since,
  )
  const actions = new Map<string, number>()
  const eventsOn = new Map<string, number>()
  const events = eventRows.map((row) => {
    const entry = toActivity(row)
    increment(actions, entry.actor)
    increment(eventsOn, row.board_id)
    const done = workflows.get(row.board_id)!.doneName
    const kind: OverviewEventKind =
      entry.type === 'created' || entry.type === 'comment'
        ? entry.type
        : entry.type === 'moved' && key(entry.data.to) === done
          ? 'completed'
          : 'update'
    return { at: entry.createdAt, kind, actor: entry.actor, boardId: row.board_id }
  })

  const lastActive = new Map(
    sql
      .all<{ actor: string; at: string }>('SELECT actor, max(created_at) AS at FROM activity GROUP BY actor')
      .map((row) => [row.actor, row.at]),
  )
  const boardLastActivity = new Map(
    sql
      .all<{ board_id: string; at: string }>(
        'SELECT t.board_id, max(a.created_at) AS at FROM activity a JOIN tickets t ON t.id = a.ticket_id GROUP BY t.board_id',
      )
      .map((row) => [row.board_id, row.at]),
  )

  // A board's host agent runs as its worker name, or as that name with a ticket's own effort. Only the board's
  // default worker is listed while idle; the per-ticket variants show up once they have work.
  const agentBoards = new Map<string, string[]>()
  const hostAgents: string[] = []
  for (const board of boards) {
    if (!board.agentEnabled) continue
    hostAgents.push(agentWorkerName(board))
    for (const effort of AGENT_EFFORTS) {
      const name = agentWorkerName({ ...board, agentEffort: effort })
      agentBoards.set(name, [...(agentBoards.get(name) ?? []), board.id])
    }
  }

  const statusRank = { working: 0, review: 1, idle: 2 }
  const agentNames = new Set([...hostAgents, ...holdings.keys(), ...workedMs.keys()])
  const agents = [...agentNames]
    .map((name): OverviewAgent => {
      const held = (holdings.get(name) ?? []).sort(
        (a, b) => statusRank[a.state] - statusRank[b.state] || a.since.localeCompare(b.since),
      )
      return {
        name,
        status: held[0]?.state ?? 'idle',
        tickets: held,
        workedMs: workedMs.get(name) ?? 0,
        completed: completedBy.get(name) ?? 0,
        actions: actions.get(name) ?? 0,
        lastActiveAt: lastActive.get(name) ?? null,
        agentOf: agentBoards.get(name) ?? [],
      }
    })
    .sort(
      (a, b) => statusRank[a.status] - statusRank[b.status] || b.workedMs - a.workedMs || a.name.localeCompare(b.name),
    )

  const overviewBoards = boards.map((board): OverviewBoard => {
    const counts = boardCounts.get(board.id) ?? { open: 0, working: 0, review: 0 }
    return {
      id: board.id,
      name: board.name,
      agentEnabled: board.agentEnabled,
      agentName: board.agentName,
      ...counts,
      completed: completedOn.get(board.id) ?? 0,
      events: eventsOn.get(board.id) ?? 0,
      lastActivityAt: boardLastActivity.get(board.id) ?? null,
    }
  })

  const recent = sql
    .all<ActivityRow & { number: number; title: string; board_id: string; board_name: string }>(
      `SELECT a.*, t.number, t.title, t.board_id, b.name AS board_name
       FROM activity a JOIN tickets t ON t.id = a.ticket_id JOIN boards b ON b.id = t.board_id
       ORDER BY a.id DESC LIMIT ?`,
      RECENT_LIMIT,
    )
    .map((row): OverviewActivity => ({
      ...toActivity(row),
      ticket: { number: row.number, title: row.title, boardId: row.board_id, boardName: row.board_name },
    }))

  const sum = (values: Iterable<number>) => [...values].reduce((total, value) => total + value, 0)
  return {
    generatedAt,
    since,
    days,
    totals: {
      boards: boards.length,
      open: sum(overviewBoards.map((board) => board.open)),
      working: sum(overviewBoards.map((board) => board.working)),
      review: sum(overviewBoards.map((board) => board.review)),
      completed: sum(completedOn.values()),
      activeAgents: agents.filter((agent) => agent.status === 'working').length,
      workedMs: sum(workedMs.values()),
    },
    agents,
    boards: overviewBoards,
    events,
    sessions: clipped,
    recent,
  }
}
