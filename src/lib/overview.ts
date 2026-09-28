import { addDays, differenceInCalendarDays, startOfDay } from 'date-fns'
import {
  addUsage,
  noUsage,
  type Overview,
  type OverviewAgent,
  type OverviewEventKind,
  type OverviewTicketUsage,
  type Tag,
  totalTokens,
  type UsageTotals,
  type WorkSession,
} from '@shared/domain'

export interface Day {
  start: Date
  events: Record<OverviewEventKind, number>
  workedMs: number
  /** Tokens agents' runs used that day. */
  usage: UsageTotals
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
  }))
  for (const event of overview.events) {
    const index = differenceInCalendarDays(Date.parse(event.at), first)
    if (index >= 0 && index < days.length) days[index].events[event.kind]++
  }
  for (const run of overview.usage) {
    const index = differenceInCalendarDays(Date.parse(run.at), first)
    if (index >= 0 && index < days.length) addUsage(days[index].usage, run)
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

/** How long a ticket can be worked without moving before it's worth a look. */
export const STALLED_MS = 24 * 60 * 60 * 1000

/** Held tickets someone should look at: those waiting in review, then those worked for long without moving. */
export function needsAttention(agents: OverviewAgent[], now: number) {
  const tickets = agents.flatMap((agent) => agent.tickets.map((ticket) => ({ ...ticket, agent: agent.name })))
  const oldest = (a: { since: string }, b: { since: string }) => a.since.localeCompare(b.since)
  return {
    review: tickets.filter((ticket) => ticket.state === 'review').sort(oldest),
    stalled: tickets
      .filter((ticket) => ticket.state === 'working' && now - Date.parse(ticket.since) >= STALLED_MS)
      .sort(oldest),
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
  const groups = new Map<string, Omit<TagUsage, 'perTicket'>>()
  for (const ticket of tickets) {
    const tags = ticket.tags.length ? ticket.tags : [null]
    for (const tag of tags) {
      const name = tag ? tag.name.toLowerCase() : ''
      const group = groups.get(name) ?? {
        tag: tag && { name: tag.name, color: tag.color },
        tickets: 0,
        total: { runs: 0, tokens: 0, costUsd: null },
      }
      groups.set(name, group)
      group.tickets++
      group.total.runs += ticket.usage.runs
      group.total.tokens += ticket.usage.tokens
      if (ticket.usage.costUsd !== null) group.total.costUsd = (group.total.costUsd ?? 0) + ticket.usage.costUsd
    }
  }
  return [...groups.values()]
    .map((group): TagUsage => ({
      ...group,
      perTicket: {
        runs: group.total.runs / group.tickets,
        tokens: group.total.tokens / group.tickets,
        costUsd: group.total.costUsd === null ? null : group.total.costUsd / group.tickets,
      },
    }))
    .sort(
      (a, b) =>
        usageValue(b.perTicket, sort) - usageValue(a.perTicket, sort) ||
        b.tickets - a.tickets ||
        (a.tag?.name ?? '').localeCompare(b.tag?.name ?? ''),
    )
}
