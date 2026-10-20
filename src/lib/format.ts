import { differenceInCalendarDays, format, formatDistanceStrict, isThisYear, parseISO } from 'date-fns'
import type { RunRecord, TicketUsage } from '@shared/domain'

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

/** E.g. `5 minutes ago`, from now or from `now` (e.g. the server's time, when it matters that its clock is off). */
export const formatRelative = (iso: string, now = Date.now()) =>
  formatDistanceStrict(parseISO(iso), now, { addSuffix: true })

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

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
const wholeNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0, useGrouping: false })
const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, useGrouping: false })

/** Disk space in steps of 1024, as `du -h` counts: `950 B`, `4.5 MB`, `44 GB` (a decimal only below 10). */
export function formatBytes(bytes: number) {
  let unit = 0
  let value = bytes
  // From 1023.5 on, the value would read 1024 rounded.
  while (value >= 1023.5 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${(unit && value < 9.95 ? oneDecimal : wholeNumber).format(value)} ${BYTE_UNITS[unit]}`
}

const dollars = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })

/**
 * US dollars to the cent, e.g. `$12.34`; amounts below a cent read `<$0.01`. Every cost on the board goes through it:
 * they are estimates (see `COST_NOTE`), so label them as such where they are shown.
 */
export const formatCost = (usd: number) => (usd > 0 && usd < 0.01 ? '<$0.01' : dollars.format(usd))

/** An amount of money in a currency, e.g. `$12.50` or `€12.50`; a currency code it doesn't know reads `12.50 XYZ`. */
export function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/**
 * What every cost the board shows is, for its tooltips: claude's `total_cost_usd`, what the runs would cost at API
 * prices, which on a subscription plan is an equivalent rather than what is billed.
 */
export const COST_NOTE =
  'Estimated: what the agent reports its runs cost at API prices. On a subscription plan this is an equivalent, not what you are billed.'

/** A ticket's usage in a few characters: its cost when its runs reported one, else its tokens. */
export const formatUsageShort = (usage: TicketUsage) =>
  usage.costUsd !== null ? formatCost(usage.costUsd) : formatTokens(usage.tokens)

/** A ticket's usage in full, e.g. `1.2M tokens over 3 runs, $4.56 estimated`. */
export function formatUsage(usage: TicketUsage) {
  const runs = `${usage.runs} ${usage.runs === 1 ? 'run' : 'runs'}`
  const cost = usage.costUsd !== null ? `, ${formatCost(usage.costUsd)} estimated` : ''
  return `${formatTokens(usage.tokens)} tokens over ${runs}${cost}`
}

/** How a run ended, for people: `finished`, or what stopped it, e.g. `failed: timed out`. */
export function formatRunOutcome(run: Pick<RunRecord, 'outcome' | 'exitCode'>) {
  switch (run.outcome) {
    case 'finished':
      return 'finished'
    case 'failed':
      return run.exitCode === null ? 'failed' : `failed: exit status ${run.exitCode}`
    case 'timed_out':
      return 'failed: timed out'
    case 'killed':
      return run.exitCode === 137 ? 'failed: killed (out of memory?)' : 'failed: killed'
    case 'stopped':
      return 'stopped: the ticket was taken away'
    case 'stop_requested':
      return 'stopped: someone asked'
    case 'usage_limit':
      return 'stopped: out of Claude usage'
  }
}

/** What a run took, e.g. `23m · 41 turns · $1.20`, leaving out what it didn't report. */
export function formatRunTotals(run: Pick<RunRecord, 'durationMs' | 'turns' | 'costUsd'>) {
  return [
    run.durationMs !== null && formatDuration(run.durationMs),
    run.turns !== null && `${run.turns} ${run.turns === 1 ? 'turn' : 'turns'}`,
    run.costUsd !== null && formatCost(run.costUsd),
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Readable model name, e.g. `Opus 5.5` for `claude-opus-5-5`, `Haiku 4.5` for `claude-haiku-4-5-20251001` and `Opus`
 * for the `opus` alias; for agents on other models, `GPT-5.1 Codex` for `gpt-5.1-codex` and `Gemini 2.5 Pro` for
 * `gemini-2.5-pro`. Names it doesn't recognise are shown as they are.
 */
export function formatModel(model: string) {
  const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?(\[1m\])?$/i.exec(model)
  if (claude) {
    const [, family, major, minor, longContext] = claude
    return `${capitalized(family)} ${major}${minor ? `.${minor}` : ''}${longContext ? ' (1M)' : ''}`
  }
  const other = /^(gpt|gemini)-(\d[\w.]*)((?:-[a-z]+)*)$/i.exec(model)
  if (other) {
    const [, family, version, variant] = other
    const name = family.toLowerCase() === 'gpt' ? `GPT-${version}` : `Gemini ${version}`
    return [name, ...variant.split('-').filter(Boolean).map(capitalized)].join(' ')
  }
  if (model.toLowerCase() === 'gpt') return 'GPT'
  return /^[a-z]+$/i.test(model) ? capitalized(model) : model
}

/** Where the board's agent runs a ticket: in a Docker container or directly on the machine. */
export const dockerLabel = (docker: boolean) => (docker ? 'Docker' : 'On the machine')

/** The board's own setting for where its agent runs tickets, for a ticket that follows it. */
export const boardDockerLabel = (docker: boolean) => `Board default (${docker ? 'Docker' : 'on the machine'})`
