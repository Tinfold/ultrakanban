/** Pure BoardDetail transformations used for optimistic updates. The server stays the source of truth. */
import {
  type BoardDetail,
  type BoardSummary,
  type Column,
  parsePullRequestUrl,
  type Tag,
  type Ticket,
} from '@shared/domain'

export type BoardPatch = Partial<
  Pick<
    BoardSummary,
    | 'name'
    | 'description'
    | 'reviewColumnId'
    | 'doneColumnId'
    | 'githubRepo'
    | 'agentEnabled'
    | 'agentName'
    | 'agentModel'
    | 'agentEffort'
    | 'agentConcurrency'
    | 'agentBacklog'
    | 'agentAllSkills'
    | 'autoMerge'
    | 'archiveDoneDays'
    | 'approvalSize'
  >
>
export type TicketPatch = Partial<
  Pick<Ticket, 'title' | 'description' | 'priority' | 'assignee' | 'dueDate' | 'agentEffort' | 'agentModel' | 'tagIds'>
>
export type ColumnPatch = Partial<Pick<Column, 'name' | 'color' | 'wipLimit'>>
export type TagPatch = Partial<Pick<Tag, 'name' | 'color'>>

/** Drops `undefined` values so a patch only changes the fields it sets, matching the API's semantics. */
const defined = <T extends object>(patch: T) =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position

export const patchBoard = (detail: BoardDetail, patch: BoardPatch): BoardDetail => ({
  ...detail,
  board: { ...detail.board, ...defined(patch) },
})

export const addTicket = (detail: BoardDetail, ticket: Ticket): BoardDetail => ({
  ...detail,
  tickets: [...detail.tickets.filter((existing) => existing.id !== ticket.id), ticket],
})

export const patchTicket = (detail: BoardDetail, ticketId: string, patch: TicketPatch): BoardDetail => ({
  ...detail,
  tickets: detail.tickets.map((ticket) => (ticket.id === ticketId ? { ...ticket, ...defined(patch) } : ticket)),
})

/** Links a pull request whose state is not known until the server has checked GitHub. */
export function linkPullRequest(detail: BoardDetail, ticketId: string, url: string | null): BoardDetail {
  const parsed = url === null ? null : parsePullRequestUrl(url)
  return {
    ...detail,
    tickets: detail.tickets.map((ticket) =>
      ticket.id === ticketId
        ? {
            ...ticket,
            pullRequest: parsed && {
              url: parsed.url,
              repo: parsed.repo,
              number: parsed.number,
              state: 'unknown',
              title: null,
              conflicts: false,
              checks: null,
              checkedAt: null,
            },
          }
        : ticket,
    ),
  }
}

export const removeTicket = (detail: BoardDetail, ticketId: string): BoardDetail => ({
  ...detail,
  tickets: detail.tickets.filter((ticket) => ticket.id !== ticketId),
})

export function moveTicket(detail: BoardDetail, ticketId: string, columnId: string, position?: number): BoardDetail {
  const ids = detail.tickets
    .filter((ticket) => ticket.columnId === columnId && ticket.id !== ticketId)
    .sort(byPosition)
    .map((ticket) => ticket.id)
  ids.splice(position ?? ids.length, 0, ticketId)
  const positions = new Map(ids.map((id, index) => [id, index]))
  return {
    ...detail,
    tickets: detail.tickets.map((ticket) => {
      if (!positions.has(ticket.id)) return ticket
      // Entering another column restarts the time towards archiving.
      const moved = ticket.id === ticketId && ticket.columnId !== columnId
      return { ...ticket, columnId, position: positions.get(ticket.id)!, ...(moved && { archived: false }) }
    }),
  }
}

export const addColumn = (detail: BoardDetail, column: Column): BoardDetail => ({
  ...detail,
  columns: [...detail.columns.filter((existing) => existing.id !== column.id), column],
})

export const patchColumn = (detail: BoardDetail, columnId: string, patch: ColumnPatch): BoardDetail => ({
  ...detail,
  columns: detail.columns.map((column) => (column.id === columnId ? { ...column, ...defined(patch) } : column)),
})

export function moveColumn(detail: BoardDetail, columnId: string, position: number): BoardDetail {
  const columns = detail.columns.filter((column) => column.id !== columnId)
  columns.splice(
    position,
    0,
    detail.columns.find((column) => column.id === columnId)!,
  )
  return { ...detail, columns: columns.map((column, index) => ({ ...column, position: index })) }
}

export function removeColumn(detail: BoardDetail, columnId: string, moveTicketsTo?: string): BoardDetail {
  const offset = detail.tickets.length
  return {
    ...detail,
    columns: detail.columns.filter((column) => column.id !== columnId),
    tickets: moveTicketsTo
      ? detail.tickets.map((ticket) =>
          ticket.columnId === columnId
            ? { ...ticket, columnId: moveTicketsTo, position: offset + ticket.position }
            : ticket,
        )
      : detail.tickets.filter((ticket) => ticket.columnId !== columnId),
  }
}

export const addTag = (detail: BoardDetail, tag: Tag): BoardDetail => ({
  ...detail,
  tags: [...detail.tags.filter((existing) => existing.id !== tag.id), tag],
})

export const patchTag = (detail: BoardDetail, tagId: string, patch: TagPatch): BoardDetail => ({
  ...detail,
  tags: detail.tags.map((tag) => (tag.id === tagId ? { ...tag, ...defined(patch) } : tag)),
})

export const removeTag = (detail: BoardDetail, tagId: string): BoardDetail => ({
  ...detail,
  tags: detail.tags.filter((tag) => tag.id !== tagId),
  tickets: detail.tickets.map((ticket) =>
    ticket.tagIds.includes(tagId) ? { ...ticket, tagIds: ticket.tagIds.filter((id) => id !== tagId) } : ticket,
  ),
})
