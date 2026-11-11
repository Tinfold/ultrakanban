import {
  AGENT_DEFAULTS,
  type AgentEffort,
  type BoardDetail,
  type BoardSummary,
  type Column,
  IN_PROGRESS_COLUMN,
  isBoardAgent,
  type Priority,
  type Tag,
  type Ticket,
  type TicketSize,
} from '@shared/domain'
import { priorityRank } from './priority'

export const SORT_OPTIONS = {
  manual: 'Manual',
  priority: 'Priority',
  dueDate: 'Due date',
  updatedAt: 'Recently updated',
  createdAt: 'Newest',
  title: 'Title',
  cost: 'Cost',
} as const

export type SortKey = keyof typeof SORT_OPTIONS

export interface TicketFilter {
  priorities: Priority[]
  tagIds: string[]
  /** `null` matches unassigned tickets. */
  assignees: (string | null)[]
  /** `null` matches tickets in no epic. Missing from view preferences saved before there were epics. */
  epicIds?: (string | null)[]
  /** Models tickets are set to; `null` matches tickets using the board's. Missing from older saved preferences. */
  models?: (string | null)[]
  /** Effort levels tickets are set to; `null` matches tickets using the board's. Missing from older saved preferences. */
  efforts?: (AgentEffort | null)[]
  /** Size estimates; `null` matches tickets without one. Missing from older saved preferences. */
  estimates?: (TicketSize | null)[]
}

export interface ViewPrefs {
  sort: SortKey
  filter: TicketFilter
  /** Whether archived tickets (long done) are shown; search finds them either way. */
  showArchived?: boolean
}

export const DEFAULT_VIEW: ViewPrefs = {
  sort: 'manual',
  filter: { priorities: [], tagIds: [], assignees: [], epicIds: [] },
}

export const NO_FILTER: TicketFilter = DEFAULT_VIEW.filter

export const activeFilterCount = (filter: TicketFilter) =>
  filter.priorities.length +
  filter.tagIds.length +
  filter.assignees.length +
  (filter.epicIds?.length ?? 0) +
  (filter.models?.length ?? 0) +
  (filter.efforts?.length ?? 0) +
  (filter.estimates?.length ?? 0)

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

export function filterTickets(
  tickets: Ticket[],
  filter: TicketFilter,
  query: string,
  tagsById: Map<string, Tag>,
  showArchived = false,
) {
  const searching = query.trim() !== ''
  return tickets.filter(
    (ticket) =>
      (showArchived || searching || !ticket.archived) &&
      (!filter.priorities.length || filter.priorities.includes(ticket.priority)) &&
      (!filter.tagIds.length || filter.tagIds.some((tagId) => ticket.tagIds.includes(tagId))) &&
      (!filter.assignees.length || filter.assignees.includes(ticket.assignee)) &&
      (!filter.epicIds?.length || filter.epicIds.includes(ticket.epicId)) &&
      (!filter.models?.length || filter.models.includes(ticket.agentModel)) &&
      (!filter.efforts?.length || filter.efforts.includes(ticket.agentEffort)) &&
      (!filter.estimates?.length || filter.estimates.includes(ticket.estimate)) &&
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
  cost: (a, b) => (b.usage.costUsd ?? -1) - (a.usage.costUsd ?? -1) || a.position - b.position,
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

export function modelsOf(tickets: Ticket[]) {
  return [...new Set(tickets.flatMap((ticket) => (ticket.agentModel ? [ticket.agentModel] : [])))].sort((a, b) =>
    a.localeCompare(b),
  )
}

/**
 * Who holds a ticket in progress other than the board's agent, e.g. another agent or a person working it through the
 * API: the agent loop neither runs it nor answers feedback on it. Null when the board's agent holds it, no one does, it
 * isn't in the In progress column, or the board has no agent switched on (then no ticket is the loop's).
 */
export function outsideAgent(
  ticket: Pick<Ticket, 'assignee'>,
  board: Pick<BoardSummary, 'agentEnabled' | 'agentName'>,
  column: Pick<Column, 'name'> | undefined,
) {
  if (!board.agentEnabled || !ticket.assignee || column?.name.toLowerCase() !== IN_PROGRESS_COLUMN) return null
  return isBoardAgent(board, ticket.assignee) ? null : ticket.assignee
}

/** What it means that someone other than the board's agent holds a ticket in progress (see `outsideAgent`). */
export const outsideAgentNote = (board: Pick<BoardSummary, 'agentName'>) =>
  `Not the board's agent (${board.agentName ?? AGENT_DEFAULTS.name}): it works this outside the agent loop, e.g. ` +
  "through the API. The loop doesn't run it or answer feedback on it."
