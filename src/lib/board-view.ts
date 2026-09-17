import type { BoardDetail, Priority, Tag, Ticket } from '@shared/domain'
import { priorityRank } from './priority'

export const SORT_OPTIONS = {
  manual: 'Manual',
  priority: 'Priority',
  dueDate: 'Due date',
  updatedAt: 'Recently updated',
  createdAt: 'Newest',
  title: 'Title',
} as const

export type SortKey = keyof typeof SORT_OPTIONS

export interface TicketFilter {
  priorities: Priority[]
  tagIds: string[]
  /** `null` matches unassigned tickets. */
  assignees: (string | null)[]
}

export interface ViewPrefs {
  sort: SortKey
  filter: TicketFilter
}

export const DEFAULT_VIEW: ViewPrefs = {
  sort: 'manual',
  filter: { priorities: [], tagIds: [], assignees: [] },
}

export const activeFilterCount = (filter: TicketFilter) =>
  filter.priorities.length + filter.tagIds.length + filter.assignees.length

function matchesQuery(ticket: Ticket, query: string, tagsById: Map<string, Tag>) {
  const needle = query
    .trim()
    .toLowerCase()
    .replace(/^#(?=\d+$)/, '')
  if (!needle) return true
  return (
    String(ticket.number) === needle ||
    ticket.title.toLowerCase().includes(needle) ||
    ticket.description.toLowerCase().includes(needle) ||
    !!ticket.assignee?.toLowerCase().includes(needle) ||
    ticket.tagIds.some((tagId) => tagsById.get(tagId)?.name.toLowerCase().includes(needle))
  )
}

export function filterTickets(tickets: Ticket[], filter: TicketFilter, query: string, tagsById: Map<string, Tag>) {
  return tickets.filter(
    (ticket) =>
      (!filter.priorities.length || filter.priorities.includes(ticket.priority)) &&
      (!filter.tagIds.length || filter.tagIds.some((tagId) => ticket.tagIds.includes(tagId))) &&
      (!filter.assignees.length || filter.assignees.includes(ticket.assignee)) &&
      matchesQuery(ticket, query, tagsById),
  )
}

const compareDue = (a: Ticket, b: Ticket) =>
  a.dueDate === b.dueDate ? 0 : !a.dueDate ? 1 : !b.dueDate ? -1 : a.dueDate.localeCompare(b.dueDate)

const COMPARATORS: Record<SortKey, (a: Ticket, b: Ticket) => number> = {
  manual: (a, b) => a.position - b.position,
  priority: (a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.position - b.position,
  dueDate: (a, b) => compareDue(a, b) || a.position - b.position,
  updatedAt: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  createdAt: (a, b) => b.createdAt.localeCompare(a.createdAt),
  title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
}

/** Ticket ids per column id, in display order. */
export function groupTickets(board: BoardDetail, tickets: Ticket[], sort: SortKey): Record<string, string[]> {
  const groups: Record<string, Ticket[]> = Object.fromEntries(board.columns.map((column) => [column.id, []]))
  for (const ticket of tickets) groups[ticket.columnId]?.push(ticket)
  return Object.fromEntries(
    Object.entries(groups).map(([columnId, group]) => [columnId, group.sort(COMPARATORS[sort]).map((t) => t.id)]),
  )
}

export function assigneesOf(tickets: Ticket[]) {
  return [...new Set(tickets.flatMap((ticket) => (ticket.assignee ? [ticket.assignee] : [])))].sort((a, b) =>
    a.localeCompare(b),
  )
}
