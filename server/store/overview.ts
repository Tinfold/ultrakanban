import {
  type Activity,
  addUsage,
  AGENT_DEFAULTS,
  AGENT_EFFORTS,
  agentWorkerName,
  noUsage,
  type Overview,
  type OverviewActivity,
  type OverviewAgent,
  type OverviewBoard,
  type OverviewCompletion,
  type OverviewEventKind,
  type OverviewRange,
  type OverviewTicket,
  type OverviewTicketUsage,
  type OverviewUsage,
  type PullRequestState,
  totalTokens,
  type UsageTotals,
  UNKNOWN_MODEL,
  type WorkSession,
  type WorkState,
  workerModel,
} from '../../shared/domain.ts'
import { sql } from '../db.ts'
import { type ActivityRow, toActivity } from './activity.ts'
import { listBoards } from './boards.ts'
import { type TagRow, toTag } from './tags.ts'
import { WAITING_SINCE } from './tickets.ts'
import { queryUsage } from './usage.ts'

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
  waiting_since: string | null
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
    `SELECT id, board_id, column_id, number, title, assignee, pr_url, pr_state, created_at,
       ${WAITING_SINCE} AS waiting_since
     FROM tickets t`,
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
  const completions: OverviewCompletion[] = []
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
    /** When work on the ticket started and when it entered the review column, for its cycle and review times. */
    let startedAt: string | null = null
    let reviewSince: string | null = null
    for (const entry of entries) {
      if (entry.type === 'created') column = key(entry.data.column)
      if (entry.type === 'moved') {
        column = key(entry.data.to)
        if (column === workflow.doneName && entry.createdAt >= since) {
          increment(completedOn, ticket.board_id)
          if (assignee) increment(completedBy, assignee)
          const at = Date.parse(entry.createdAt)
          completions.push({
            ticketId: ticket.id,
            boardId: ticket.board_id,
            at: entry.createdAt,
            cycleMs: startedAt ? at - Date.parse(startedAt) : null,
            reviewMs: reviewSince ? at - Date.parse(reviewSince) : null,
          })
        }
        // Reopened tickets start over.
        if (column === workflow.doneName) startedAt = null
        reviewSince = column === workflow.reviewName ? (reviewSince ?? entry.createdAt) : null
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
        startedAt ??= entry.createdAt
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

  // Tokens agents' runs used.
  const usage = queryUsage('created_at >= ?', since).map((run): OverviewUsage => {
    const counts = {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      cacheWriteTokens: run.cacheWriteTokens,
      costUsd: run.costUsd,
    }
    return {
      at: run.createdAt,
      agent: run.agent,
      ticketId: run.ticketId,
      boardId: run.boardId,
      ...counts,
      // Runs that didn't report their models ran the one in the agent's name, if it has one.
      models: run.models.length ? run.models : [{ model: workerModel(run.agent) ?? UNKNOWN_MODEL, ...counts }],
    }
  })
  const usageBy = new Map<string, UsageTotals>()
  const tokensOn = new Map<string, number>()
  for (const run of usage) {
    usageBy.set(run.agent, addUsage(usageBy.get(run.agent) ?? noUsage(), run))
    tokensOn.set(run.boardId, (tokensOn.get(run.boardId) ?? 0) + totalTokens(run))
  }

  // Tickets worked within the range, with everything their runs used.
  const workedTickets = 'SELECT ticket_id FROM token_usage WHERE created_at >= ? AND ticket_id IS NOT NULL'
  const ticketTags = new Map<string, TagRow[]>()
  for (const row of sql.all<TagRow & { ticket_id: string }>(
    `SELECT tt.ticket_id, g.* FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id
     WHERE tt.ticket_id IN (${workedTickets}) ORDER BY g.name`,
    since,
  )) {
    ticketTags.set(row.ticket_id, [...(ticketTags.get(row.ticket_id) ?? []), row])
  }
  const ticketUsage = sql
    .all<{ ticket_id: string; runs: number; tokens: number; cost: number | null }>(
      `SELECT ticket_id, count(*) AS runs,
         sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens, sum(cost_usd) AS cost
       FROM token_usage WHERE ticket_id IN (${workedTickets}) GROUP BY ticket_id`,
      since,
    )
    .map((row): OverviewTicketUsage => {
      const ticket = ticketsById.get(row.ticket_id)!
      return {
        id: ticket.id,
        boardId: ticket.board_id,
        boardName: boardNames.get(ticket.board_id)!,
        number: ticket.number,
        title: ticket.title,
        column: columnNames.get(ticket.column_id)!,
        tags: (ticketTags.get(ticket.id) ?? []).map(toTag),
        usage: { runs: row.runs, tokens: row.tokens, costUsd: row.cost },
      }
    })
    .sort((a, b) => b.usage.tokens - a.usage.tokens || a.number - b.number)

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
      waitingSince: ticket.waiting_since,
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

  const lastActivity = sql.all<{ actor: string; at: string; id: number }>(
    'SELECT actor, max(created_at) AS at, max(id) AS id FROM activity GROUP BY actor',
  )
  const lastActive = new Map(lastActivity.map((row) => [row.actor, row.at]))
  const lastActivityId = new Map(lastActivity.map((row) => [row.actor, row.id]))
  const boardLastActivity = new Map(
    sql
      .all<{ board_id: string; at: string }>(
        'SELECT t.board_id, max(a.created_at) AS at FROM activity a JOIN tickets t ON t.id = a.ticket_id GROUP BY t.board_id',
      )
      .map((row) => [row.board_id, row.at]),
  )

  // A board's host agent runs as its worker name, or as that name with a ticket's own model and effort. Only the
  // board's default worker is listed while idle; the per-ticket variants show up once they have work.
  const ticketModels = new Map<string, string[]>()
  for (const row of sql.all<{ board_id: string; agent_model: string }>(
    'SELECT DISTINCT board_id, agent_model FROM tickets WHERE agent_model IS NOT NULL',
  )) {
    ticketModels.set(row.board_id, [...(ticketModels.get(row.board_id) ?? []), row.agent_model])
  }
  const agentBoards = new Map<string, string[]>()
  const hostAgents: string[] = []
  for (const board of boards) {
    if (!board.agentEnabled) continue
    hostAgents.push(agentWorkerName(board))
    const models = new Set([board.agentModel ?? AGENT_DEFAULTS.model, ...(ticketModels.get(board.id) ?? [])])
    for (const agentModel of models) {
      for (const agentEffort of AGENT_EFFORTS) {
        const name = agentWorkerName({ ...board, agentModel, agentEffort })
        agentBoards.set(name, [...(agentBoards.get(name) ?? []), board.id])
      }
    }
  }

  // Cleared agents stay out of the list until they do something again.
  const hiddenUntil = new Map(
    sql
      .all<{ name: string; last_activity_id: number }>('SELECT name, last_activity_id FROM hidden_agents')
      .map((row) => [row.name, row.last_activity_id]),
  )
  const isHidden = (name: string) => {
    const hidden = hiddenUntil.get(name)
    return hidden !== undefined && (lastActivityId.get(name) ?? 0) <= hidden
  }

  const statusRank = { working: 0, review: 1, idle: 2 }
  const agentNames = new Set([...hostAgents, ...holdings.keys(), ...workedMs.keys(), ...usageBy.keys()])
  const hiddenAgents = [...agentNames].filter(isHidden).sort()
  const agents = [...agentNames]
    .filter((name) => !isHidden(name))
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
        usage: usageBy.get(name) ?? noUsage(),
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
      tokens: tokensOn.get(board.id) ?? 0,
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
      // Parallel runs share their agent's name but each works its own ticket, so count the tickets, not the names.
      activeAgents: sum(agents.map((agent) => agent.tickets.filter((held) => held.state === 'working').length)),
      workedMs: sum(workedMs.values()),
      usage: usage.reduce(addUsage, noUsage()),
    },
    agents,
    hiddenAgents,
    boards: overviewBoards,
    events,
    sessions: clipped,
    completions: completions.sort((a, b) => a.at.localeCompare(b.at)),
    usage,
    tickets: ticketUsage,
    recent,
  }
}

/** Clears agents from the overview until they next do something on a board. */
export function hideAgents(names: string[]) {
  const { id } = sql.get<{ id: number | null }>('SELECT max(id) AS id FROM activity')!
  for (const name of names) {
    sql.run(
      `INSERT INTO hidden_agents (name, last_activity_id) VALUES (?, ?)
       ON CONFLICT (name) DO UPDATE SET last_activity_id = excluded.last_activity_id`,
      name,
      id ?? 0,
    )
  }
}

/** Lists every cleared agent in the overview again. */
export const showHiddenAgents = () => sql.run('DELETE FROM hidden_agents')
