import { addDays, differenceInCalendarDays, startOfDay } from 'date-fns'
import {
  addUsage,
  noUsage,
  type Overview,
  type OverviewAgent,
  type OverviewEventKind,
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
