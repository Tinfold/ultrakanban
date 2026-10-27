import { addDays, differenceInCalendarDays, startOfDay } from 'date-fns'
import {
  addUsage,
  type BoardDiskUsage,
  noUsage,
  type Overview,
  type OverviewActivity,
  type OverviewAgent,
  type OverviewCompletion,
  type OverviewEventKind,
  type OverviewTicketUsage,
  type Tag,
  totalTokens,
  type UsageTotals,
  type WorkSession,
} from '@shared/domain'

/** All of a board's disk space, in bytes. */
export const diskBytes = ({ attachments, agent }: BoardDiskUsage) =>
  attachments + (agent ? agent.repo + agent.worktrees + agent.state : 0)

export interface Day {
  start: Date
  events: Record<OverviewEventKind, number>
  workedMs: number
  /** Tokens agents' runs used that day. */
  usage: UsageTotals
  /** Of their cost, what runs on the agents' API key spent: billed, not estimated (see `AgentApiKey`). */
  apiKeyCostUsd: number
}

const sessionEnd = (session: WorkSession, now: number) => (session.end ? Date.parse(session.end) : now)

/** The overview's range as local calendar days, the last one being today. Ongoing work counts up to `now`. */
export function dailyActivity(overview: Overview, now: number): Day[] {
  const first = addDays(startOfDay(now), 1 - overview.days)
  const days: Day[] = Array.from({ length: overview.days }, (_, i) => ({
    start: addDays(first, i),
    events: { created: 0, completed: 0, comment: 0, update: 0 },
    workedMs: 0,
    usage: noUsage(),
    apiKeyCostUsd: 0,
  }))
  for (const event of overview.events) {
    const index = differenceInCalendarDays(Date.parse(event.at), first)
    if (index >= 0 && index < days.length) days[index].events[event.kind]++
  }
  for (const run of overview.usage) {
    const index = differenceInCalendarDays(Date.parse(run.at), first)
    if (index < 0 || index >= days.length) continue
    addUsage(days[index].usage, run)
    if (run.apiKey && run.costUsd !== null) days[index].apiKeyCostUsd += run.costUsd
  }
  for (const session of overview.sessions) {
    const start = Date.parse(session.start)
    const end = sessionEnd(session, now)
    days.forEach((day, i) => {
      const next = days[i + 1]?.start.getTime() ?? Infinity
      day.workedMs += Math.max(0, Math.min(end, next) - Math.max(start, day.start.getTime()))
    })
  }
  return days
}

/** Work time per agent from `from` on; ongoing work counts up to `now`. */
export function workedByAgent(sessions: WorkSession[], from: Date, now: number) {
  const worked = new Map<string, number>()
  for (const session of sessions) {
    const duration = sessionEnd(session, now) - Math.max(Date.parse(session.start), from.getTime())
    if (duration > 0) worked.set(session.agent, (worked.get(session.agent) ?? 0) + duration)
  }
  return worked
}

/** Opens a ticket on its board. */
export const ticketHref = (ticket: { id: string; boardId: string }) => `/b/${ticket.boardId}?ticket=${ticket.id}`

/**
 * The middle value, or null without any. With an even count it's the lower of the two middle values rather than
 * their average, so it's always a real duration, and review wait never looks longer than the cycle it's part of.
 */
export function median(values: number[]) {
  if (!values.length) return null
  return values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) / 2)]
}

/**
 * What a completed ticket cost, on average over all its agent runs: the mean of the completions whose runs reported a
 * cost, a ticket completed more than once counting once. Null when none did, e.g. agents on a local model.
 */
export function costPerCompletedTicket(completions: OverviewCompletion[]) {
  const costs = new Map<string, number>()
  for (const completion of completions) {
    if (completion.costUsd !== null) costs.set(completion.ticketId, completion.costUsd)
  }
  if (!costs.size) return null
  const total = [...costs.values()].reduce((sum, cost) => sum + cost, 0)
  return { costUsd: total / costs.size, tickets: costs.size }
}

/** How long a ticket can be worked without moving before it's worth a look. */
export const STALLED_MS = 24 * 60 * 60 * 1000

/**
 * Held tickets someone should look at: those whose agent waits for an answer, those waiting in review, then those
 * worked for long without moving (and not waiting for an answer).
 */
export function needsAttention(agents: OverviewAgent[], now: number) {
  const tickets = agents.flatMap((agent) => agent.tickets.map((ticket) => ({ ...ticket, agent: agent.name })))
  const oldest = (a: { since: string }, b: { since: string }) => a.since.localeCompare(b.since)
  return {
    waiting: tickets
      .filter((ticket) => ticket.state === 'working' && ticket.waitingSince)
      .sort((a, b) => a.waitingSince!.localeCompare(b.waitingSince!)),
    review: tickets.filter((ticket) => ticket.state === 'review').sort(oldest),
    stalled: tickets
      .filter(
        (ticket) => ticket.state === 'working' && !ticket.waitingSince && now - Date.parse(ticket.since) >= STALLED_MS,
      )
      .sort(oldest),
  }
}

const STATUS_ORDER: Record<OverviewAgent['status'], number> = { working: 0, review: 1, idle: 2 }

/**
 * The agents to list: working ones first, then those waiting for review, then idle ones, each by when they were last
 * active, most recent first. Busy agents get a card, idle ones a compact row in a group of their own.
 */
export function groupAgents(agents: OverviewAgent[]) {
  const sorted = [...agents].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '') ||
      a.name.localeCompare(b.name),
  )
  return {
    busy: sorted.filter((agent) => agent.status !== 'idle'),
    idle: sorted.filter((agent) => agent.status === 'idle'),
  }
}

/** The most colors a chart shows models in; beyond that the rest share one. */
const MODEL_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

export interface ModelSeries {
  label: string
  color: string
  /** Models the series adds up: one, or the rest for `Other`. */
  models: string[]
}

/** Models from the most tokens used to the least, each with its totals. */
export const modelsByTokens = (usage: UsageTotals) =>
  Object.entries(usage.models)
    .map(([model, counts]) => ({ model, ...counts }))
    .sort((a, b) => totalTokens(b) - totalTokens(a) || a.model.localeCompare(b.model))

/** A chart series per model, most tokens first; when there are too many for the colors, the least used share one. */
export function modelSeries(usage: UsageTotals, label: (model: string) => string): ModelSeries[] {
  const models = modelsByTokens(usage).map((entry) => entry.model)
  const shown = models.length > MODEL_COLORS.length ? models.slice(0, MODEL_COLORS.length - 1) : models
  const series = shown.map((model, i) => ({ label: label(model), color: MODEL_COLORS[i], models: [model] }))
  if (shown.length < models.length) {
    series.push({ label: 'Other', color: MODEL_COLORS.at(-1)!, models: models.slice(shown.length) })
  }
  return series
}

/** Tokens the models of a series used. */
export const seriesTokens = (usage: UsageTotals, series: ModelSeries) =>
  series.models.reduce((total, model) => total + (usage.models[model] ? totalTokens(usage.models[model]) : 0), 0)

/** What the overview's ticket usage table sorts by. */
export type UsageSort = 'tokens' | 'cost' | 'runs'

const usageValue = (usage: OverviewTicketUsage['usage'], sort: UsageSort) =>
  sort === 'tokens' ? usage.tokens : sort === 'cost' ? (usage.costUsd ?? 0) : usage.runs

/** Tickets sorted by `sort`, highest first. */
export const sortTicketUsage = (tickets: OverviewTicketUsage[], sort: UsageSort) =>
  tickets.toSorted(
    (a, b) =>
      usageValue(b.usage, sort) - usageValue(a.usage, sort) ||
      b.usage.tokens - a.usage.tokens ||
      a.boardName.localeCompare(b.boardName) ||
      a.number - b.number,
  )

/** A tag's tickets' usage: added up, and per ticket on average. */
export interface TagUsage {
  /** `null` for tickets without tags. */
  tag: Pick<Tag, 'name' | 'color'> | null
  tickets: number
  total: OverviewTicketUsage['usage']
  perTicket: { runs: number; tokens: number; costUsd: number | null }
}

/**
 * Ticket usage grouped by tag name across boards, so kinds of tickets can be compared; a ticket with several tags
 * counts towards each. Sorted by the average per ticket of `sort`, highest first.
 */
export function usageByTag(tickets: OverviewTicketUsage[], sort: UsageSort): TagUsage[] {
  const groups = new Map<string, Omit<TagUsage, 'perTicket'> & { costed: number }>()
  for (const ticket of tickets) {
    const tags = ticket.tags.length ? ticket.tags : [null]
    for (const tag of tags) {
      const name = tag ? tag.name.toLowerCase() : ''
      const group = groups.get(name) ?? {
        tag: tag && { name: tag.name, color: tag.color },
        tickets: 0,
        costed: 0,
        total: { runs: 0, tokens: 0, costUsd: null },
      }
      groups.set(name, group)
      group.tickets++
      group.total.runs += ticket.usage.runs
      group.total.tokens += ticket.usage.tokens
      if (ticket.usage.costUsd !== null) {
        group.costed++
        group.total.costUsd = (group.total.costUsd ?? 0) + ticket.usage.costUsd
      }
    }
  }
  return [...groups.values()]
    .map(({ costed, ...group }): TagUsage => ({
      ...group,
      perTicket: {
        runs: group.total.runs / group.tickets,
        tokens: group.total.tokens / group.tickets,
        costUsd: group.total.costUsd === null ? null : group.total.costUsd / costed,
      },
    }))
    .sort(
      (a, b) =>
        usageValue(b.perTicket, sort) - usageValue(a.perTicket, sort) ||
        b.tickets - a.tickets ||
        (a.tag?.name ?? '').localeCompare(b.tag?.name ?? ''),
    )
}

const PULL_REQUEST_EVENTS = {
  linked: 'linked a pull request to',
  unlinked: 'unlinked the pull request of',
  open: 'reports the pull request open for',
  draft: 'reports the pull request back in draft for',
  merged: 'reports the pull request merged for',
  closed: 'reports the pull request closed for',
} as const

/** What an activity entry did, worded to go between its actor and its ticket. */
export function activityVerb(entry: OverviewActivity) {
  switch (entry.type) {
    case 'created':
      return 'created'
    case 'updated':
      return 'edited'
    case 'checked':
      return entry.data.checked ? 'checked off an item of' : 'unchecked an item of'
    case 'moved':
      return `moved to ${entry.data.to}`
    case 'claimed':
      return entry.actor === entry.data.assignee ? 'claimed' : `assigned ${entry.data.assignee} to`
    case 'released':
      return entry.actor === entry.data.assignee ? 'released' : `unassigned ${entry.data.assignee} from`
    case 'comment':
      return 'commented on'
    case 'plan':
      return entry.data.held ? 'posted a plan, waiting for approval, for' : 'posted a plan for'
    case 'approved':
      return 'approved the plan of'
    case 'stopped':
      return "stopped the agent's run on"
    case 'attachment':
      return 'attached a file to'
    case 'pull_request':
      return PULL_REQUEST_EVENTS[entry.data.event]
  }
}

/** How close together a ticket's events have to be to show as one entry of the feed. */
export const MERGE_ACTIVITY_MS = 2 * 60 * 1000

/** Activity entries on one ticket shown as one line: "claude/opus/high picked up #83 · In progress". */
export interface ActivityGroup {
  /** The newest event's id. */
  id: number
  actor: string
  verb: string
  /** The column the ticket ended up in, when the group moved it and `verb` doesn't already say so. */
  column: string | null
  ticketId: string
  ticket: OverviewActivity['ticket']
  /** The newest event's time. */
  createdAt: string
  /** The raw events, oldest first. */
  events: OverviewActivity[]
}

const joinWords = (words: string[]) =>
  words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/** Words a group of events as one line. */
function describeGroup(events: OverviewActivity[]): Pick<ActivityGroup, 'actor' | 'verb' | 'column'> {
  const newest = (list: OverviewActivity[]) => list.at(-1)
  const moved = newest(events.filter((event) => event.type === 'moved'))
  const column = moved?.type === 'moved' ? moved.data.to : null
  if (events.length === 1) return { actor: events[0].actor, verb: activityVerb(events[0]), column: null }

  const merged = events.find((event) => event.type === 'pull_request' && event.data.event === 'merged')
  if (merged) return { actor: merged.actor, verb: 'merged', column }
  // The agent loop claims a ticket, moves it, then hands it to the agent that runs it: unassign, assign.
  const assignment = newest(events.filter((event) => event.type === 'claimed' || event.type === 'released'))
  if (assignment?.type === 'claimed') return { actor: assignment.data.assignee, verb: 'picked up', column }

  const rest = events.filter((event) => event.type !== 'moved')
  if (!rest.length) return { actor: moved!.actor, verb: activityVerb(moved!), column: null }
  return { actor: newest(rest)!.actor, verb: joinWords([...new Set(rest.map(activityVerb))]), column }
}

/**
 * Merges the feed's near-duplicates: a ticket's events within `MERGE_ACTIVITY_MS` of the newest one become one
 * entry, even with other tickets' events in between. Takes and returns the newest first.
 */
export function mergeActivity(activity: OverviewActivity[], windowMs = MERGE_ACTIVITY_MS): ActivityGroup[] {
  const groups: { newest: OverviewActivity; events: OverviewActivity[] }[] = []
  const open = new Map<string, (typeof groups)[number]>()
  for (const event of activity) {
    const group = open.get(event.ticketId)
    if (group && Date.parse(group.newest.createdAt) - Date.parse(event.createdAt) <= windowMs) {
      group.events.unshift(event)
      continue
    }
    const added = { newest: event, events: [event] }
    groups.push(added)
    open.set(event.ticketId, added)
  }
  return groups.map(({ newest, events }) => ({
    id: newest.id,
    ...describeGroup(events),
    ticketId: newest.ticketId,
    ticket: newest.ticket,
    createdAt: newest.createdAt,
    events,
  }))
}
