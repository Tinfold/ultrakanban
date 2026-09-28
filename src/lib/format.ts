import { differenceInCalendarDays, format, formatDistanceToNowStrict, isThisYear, parseISO } from 'date-fns'
import type { TicketUsage } from '@shared/domain'

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

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/** Compact token count, e.g. `950`, `12.3K`, `4.5M`. */
export const formatTokens = (count: number) => compactNumber.format(count)

const dollars = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })

/** US dollars to the cent, e.g. `$12.34`; amounts below a cent read `<$0.01`. */
export const formatCost = (usd: number) => (usd > 0 && usd < 0.01 ? '<$0.01' : dollars.format(usd))

/** A ticket's usage in a few characters: its cost when its runs reported one, else its tokens. */
export const formatUsageShort = (usage: TicketUsage) =>
  usage.costUsd !== null ? formatCost(usage.costUsd) : formatTokens(usage.tokens)

/** A ticket's usage in full, e.g. `1.2M tokens over 3 runs, $4.56`. */
export function formatUsage(usage: TicketUsage) {
  const runs = `${usage.runs} ${usage.runs === 1 ? 'run' : 'runs'}`
  const cost = usage.costUsd !== null ? `, ${formatCost(usage.costUsd)}` : ''
  return `${formatTokens(usage.tokens)} tokens over ${runs}${cost}`
}

/**
 * Readable model name, e.g. `Opus 5.5` for `claude-opus-5-5`, `Haiku 4.5` for `claude-haiku-4-5-20251001` and `Opus`
 * for the `opus` alias. Names it doesn't recognise are shown as they are.
 */
export function formatModel(model: string) {
  const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?(\[1m\])?$/i.exec(model)
  if (match) {
    const [, family, major, minor, longContext] = match
    return `${capitalized(family)} ${major}${minor ? `.${minor}` : ''}${longContext ? ' (1M)' : ''}`
  }
  return /^[a-z]+$/i.test(model) ? capitalized(model) : model
}
