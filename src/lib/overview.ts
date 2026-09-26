import { addDays, differenceInCalendarDays, startOfDay } from 'date-fns'
import type { Overview, OverviewEventKind, WorkSession } from '@shared/domain'

export interface Day {
  start: Date
  events: Record<OverviewEventKind, number>
  workedMs: number
}

const sessionEnd = (session: WorkSession, now: number) => (session.end ? Date.parse(session.end) : now)

/** The overview's range as local calendar days, the last one being today. Ongoing work counts up to `now`. */
export function dailyActivity(overview: Overview, now: number): Day[] {
  const first = addDays(startOfDay(now), 1 - overview.days)
  const days: Day[] = Array.from({ length: overview.days }, (_, i) => ({
    start: addDays(first, i),
    events: { created: 0, completed: 0, comment: 0, update: 0 },
    workedMs: 0,
  }))
  for (const event of overview.events) {
    const index = differenceInCalendarDays(Date.parse(event.at), first)
    if (index >= 0 && index < days.length) days[index].events[event.kind]++
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
