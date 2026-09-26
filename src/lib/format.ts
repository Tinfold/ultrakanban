import { differenceInCalendarDays, format, formatDistanceToNowStrict, isThisYear, parseISO } from 'date-fns'

export const toISODate = (date: Date) => format(date, 'yyyy-MM-dd')

export const parseISODate = (value: string) => parseISO(value)

export function formatDueDate(value: string) {
  const date = parseISO(value)
  const days = differenceInCalendarDays(date, new Date())
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  return format(date, isThisYear(date) ? 'MMM d' : 'MMM d, yyyy')
}

export function dueState(value: string): 'overdue' | 'soon' | 'later' {
  const days = differenceInCalendarDays(parseISO(value), new Date())
  return days < 0 ? 'overdue' : days <= 2 ? 'soon' : 'later'
}

export const formatRelative = (iso: string) => formatDistanceToNowStrict(parseISO(iso), { addSuffix: true })

export const formatDateTime = (iso: string) => format(parseISO(iso), 'MMM d, yyyy, HH:mm')

export const ticketRef = (number: number) => `#${number}`

/** Compact duration, e.g. `3h 20m`, `45m`, `2d 4h`. */
export function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return ms > 0 ? '<1m' : '0m'
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days) return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
  if (hours) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  return `${minutes}m`
}
