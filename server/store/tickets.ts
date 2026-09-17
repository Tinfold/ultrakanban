import {
  type Column,
  parsePullRequestUrl,
  PRIORITIES,
  type Priority,
  type PullRequest,
  type PullRequestState,
  type Ticket,
} from '../../shared/domain.ts'
import type {
  ClaimNextInput,
  ClaimTicketInput,
  CreateTicketInput,
  ListTicketsQuery,
  MoveTicketInput,
  ReleaseTicketInput,
  SubmitForReviewInput,
  UpdateTicketInput,
} from '../../shared/schemas.ts'
import { newId, now, reorder, sql, touchBoard, updateRow } from '../db.ts'
import { badRequest, conflict, HttpError, notFound } from '../errors.ts'
import { logActivity } from './activity.ts'
import { getColumn, listColumns, resolveColumn, workflowColumns } from './columns.ts'
import { resolveTags } from './tags.ts'

interface TicketRow {
  id: string
  board_id: string
  column_id: string
  number: number
  title: string
  description: string
  priority: number
  assignee: string | null
  due_date: string | null
  pr_url: string | null
  pr_state: string
  pr_title: string | null
  pr_checked_at: string | null
  position: number
  version: number
  created_at: string
  updated_at: string
  tag_ids: string | null
  comment_count: number
  attachment_count: number
}

const SELECT_TICKETS = `
  SELECT t.*,
    (SELECT group_concat(tag_id) FROM ticket_tags WHERE ticket_id = t.id) AS tag_ids,
    (SELECT count(*) FROM activity WHERE ticket_id = t.id AND type = 'comment') AS comment_count,
    (SELECT count(*) FROM attachments WHERE ticket_id = t.id) AS attachment_count
  FROM tickets t`

const BOARD_ORDER = 'ORDER BY (SELECT position FROM columns WHERE id = t.column_id), t.position'

function toPullRequest(url: string, row: TicketRow): PullRequest {
  const { repo, number } = parsePullRequestUrl(url)!
  return {
    url,
    repo,
    number,
    state: row.pr_state as PullRequestState,
    title: row.pr_title,
    checkedAt: row.pr_checked_at,
  }
}

const toTicket = (row: TicketRow): Ticket => ({
  id: row.id,
  boardId: row.board_id,
  number: row.number,
  columnId: row.column_id,
  title: row.title,
  description: row.description,
  priority: PRIORITIES[row.priority],
  assignee: row.assignee,
  dueDate: row.due_date,
  tagIds: row.tag_ids ? row.tag_ids.split(',') : [],
  pullRequest: row.pr_url ? toPullRequest(row.pr_url, row) : null,
  position: row.position,
  version: row.version,
  commentCount: row.comment_count,
  attachmentCount: row.attachment_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const priorityRank = (priority: Priority) => PRIORITIES.indexOf(priority)

const EDITABLE_FIELDS = ['title', 'description', 'priority', 'dueDate'] as const

/** Actor recorded for changes caused by GitHub pull request updates. */
export const GITHUB_ACTOR = 'github'

export function getTicket(id: string): Ticket {
  const row = sql.get<TicketRow>(`${SELECT_TICKETS} WHERE t.id = ?`, id)
  if (!row) throw notFound('Ticket', id)
  return toTicket(row)
}

export function getTicketByNumber(boardId: string, number: number): Ticket {
  const row = sql.get<TicketRow>(`${SELECT_TICKETS} WHERE t.board_id = ? AND t.number = ?`, boardId, number)
  if (!row) throw notFound('Ticket', `#${number}`)
  return toTicket(row)
}

export function listTickets(boardId: string, query: ListTicketsQuery = {}): Ticket[] {
  const where = ['t.board_id = ?']
  const params: (string | number)[] = [boardId]

  if (query.column) {
    where.push('t.column_id = ?')
    params.push(resolveColumn(boardId, query.column).id)
  }
  if (query.assignee) {
    where.push('t.assignee = ?')
    params.push(query.assignee)
  }
  if (query.unassigned !== undefined) {
    where.push(query.unassigned ? 't.assignee IS NULL' : 't.assignee IS NOT NULL')
  }
  for (const tagId of resolveTags(boardId, query.tag ?? [], { create: false })) {
    where.push('EXISTS (SELECT 1 FROM ticket_tags WHERE ticket_id = t.id AND tag_id = ?)')
    params.push(tagId)
  }
  if (query.priority?.length) {
    where.push(`t.priority IN (${query.priority.map(() => '?').join(', ')})`)
    params.push(...query.priority.map(priorityRank))
  }
  if (query.q) {
    where.push("(t.title LIKE ? OR t.description LIKE ? OR ('#' || t.number) = ?)")
    params.push(`%${query.q}%`, `%${query.q}%`, query.q.startsWith('#') ? query.q : `#${query.q}`)
  }

  return sql.all<TicketRow>(`${SELECT_TICKETS} WHERE ${where.join(' AND ')} ${BOARD_ORDER}`, ...params).map(toTicket)
}

function assertVersion(ticket: Ticket, ifVersion: number | undefined) {
  if (ifVersion !== undefined && ticket.version !== ifVersion) {
    throw conflict(
      'version_conflict',
      `Ticket was modified concurrently (current version ${ticket.version}, expected ${ifVersion})`,
      { ticket },
    )
  }
}

function bumpVersion(id: string) {
  sql.run('UPDATE tickets SET version = version + 1, updated_at = ? WHERE id = ?', now(), id)
}

function setTags(ticketId: string, tagIds: string[]) {
  sql.run('DELETE FROM ticket_tags WHERE ticket_id = ?', ticketId)
  for (const tagId of tagIds) sql.run('INSERT INTO ticket_tags (ticket_id, tag_id) VALUES (?, ?)', ticketId, tagId)
}

/** Places a ticket at `position` in a column (end of column by default), reindexing siblings. */
function place(ticket: Ticket, columnId: string, position?: number) {
  const ids = sql
    .all<{ id: string }>(
      'SELECT id FROM tickets WHERE column_id = ? AND id != ? ORDER BY position',
      columnId,
      ticket.id,
    )
    .map((row) => row.id)
  ids.splice(position ?? ids.length, 0, ticket.id)
  if (columnId !== ticket.columnId) sql.run('UPDATE tickets SET column_id = ? WHERE id = ?', columnId, ticket.id)
  reorder('tickets', ids)
}

/** The board's done column only accepts tickets whose pull request is merged, unless forced. */
function assertCanEnter(
  ticket: Pick<Ticket, 'boardId' | 'pullRequest'> & { columnId: string | null },
  target: Column,
  force = false,
) {
  if (force || target.id === ticket.columnId || ticket.pullRequest?.state === 'merged') return
  if (target.id !== workflowColumns(ticket.boardId).done?.id) return
  throw conflict(
    'pull_request_not_merged',
    ticket.pullRequest
      ? `Tickets enter "${target.name}" when their pull request is merged; ${ticket.pullRequest.url} is ${ticket.pullRequest.state}. It will move automatically once merged.`
      : `Tickets enter "${target.name}" only with a merged pull request. Link one with POST /api/tickets/:id/review.`,
    { ticket },
  )
}

function relocate(ticket: Ticket, columnRef: string, position: number | undefined, actor: string, force?: boolean) {
  const target = resolveColumn(ticket.boardId, columnRef)
  assertCanEnter(ticket, target, force)
  place(ticket, target.id, position)
  if (target.id !== ticket.columnId) {
    logActivity(ticket.id, actor, 'moved', { from: getColumn(ticket.columnId).name, to: target.name })
  }
}

function assign(ticket: Ticket, assignee: string | null, actor: string) {
  if (ticket.assignee === assignee) return
  sql.run('UPDATE tickets SET assignee = ? WHERE id = ?', assignee, ticket.id)
  if (ticket.assignee) logActivity(ticket.id, actor, 'released', { assignee: ticket.assignee })
  if (assignee) logActivity(ticket.id, actor, 'claimed', { assignee })
}

/** Links (or with `null` unlinks) a pull request. Returns whether the link changed. */
function linkPullRequest(ticket: Ticket, url: string | null, actor: string) {
  const next = url === null ? null : parsePullRequestUrl(url)!.url
  const current = ticket.pullRequest?.url ?? null
  if (next === current) return false
  sql.run(
    "UPDATE tickets SET pr_url = ?, pr_state = 'unknown', pr_title = NULL, pr_checked_at = NULL WHERE id = ?",
    next,
    ticket.id,
  )
  if (current) logActivity(ticket.id, actor, 'pull_request', { url: current, event: 'unlinked' })
  if (next) logActivity(ticket.id, actor, 'pull_request', { url: next, event: 'linked' })
  return true
}

export function createTicket(boardId: string, input: CreateTicketInput, actor: string): Ticket {
  touchBoard(boardId)
  const column = input.column ? resolveColumn(boardId, input.column) : listColumns(boardId)[0]
  if (!column) throw badRequest('Board has no columns; create a column first')
  assertCanEnter({ boardId, columnId: null, pullRequest: null }, column, input.force)

  const { number } = sql.get<{ number: number }>(
    'UPDATE boards SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number',
    boardId,
  )!
  const { count } = sql.get<{ count: number }>('SELECT count(*) AS count FROM tickets WHERE column_id = ?', column.id)!
  const id = newId()
  const timestamp = now()
  sql.run(
    `INSERT INTO tickets (id, board_id, column_id, number, title, description, priority, assignee, due_date,
       position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    boardId,
    column.id,
    number,
    input.title,
    input.description ?? '',
    priorityRank(input.priority ?? 'none'),
    input.assignee ?? null,
    input.dueDate ?? null,
    count,
    timestamp,
    timestamp,
  )
  logActivity(id, actor, 'created', { column: column.name })
  if (input.position !== undefined) place(getTicket(id), column.id, input.position)
  if (input.tags) setTags(id, resolveTags(boardId, input.tags, { create: true }))
  if (input.pullRequest) linkPullRequest(getTicket(id), input.pullRequest, actor)
  return getTicket(id)
}

export function updateTicket(id: string, input: UpdateTicketInput, actor: string): Ticket {
  const ticket = getTicket(id)
  assertVersion(ticket, input.ifVersion)
  touchBoard(ticket.boardId)

  const changed: string[] = EDITABLE_FIELDS.filter(
    (field) => input[field] !== undefined && input[field] !== ticket[field],
  )
  const has = (field: string) => changed.includes(field)
  updateRow('tickets', id, {
    title: has('title') ? input.title : undefined,
    description: has('description') ? input.description : undefined,
    priority: has('priority') && input.priority ? priorityRank(input.priority) : undefined,
    due_date: has('dueDate') ? input.dueDate : undefined,
  })

  if (input.tags) {
    const tagIds = resolveTags(ticket.boardId, input.tags, { create: true })
    if (tagIds.length !== ticket.tagIds.length || tagIds.some((tagId) => !ticket.tagIds.includes(tagId))) {
      setTags(id, tagIds)
      changed.push('tags')
    }
  }
  if (changed.length) logActivity(id, actor, 'updated', { fields: changed })

  const reassigned = input.assignee !== undefined && input.assignee !== ticket.assignee
  if (reassigned) assign(ticket, input.assignee ?? null, actor)
  const relinked = input.pullRequest !== undefined && linkPullRequest(ticket, input.pullRequest, actor)

  if (!changed.length && !reassigned && !relinked) return ticket
  bumpVersion(id)
  return getTicket(id)
}

export function moveTicket(id: string, input: MoveTicketInput, actor: string): Ticket {
  const ticket = getTicket(id)
  assertVersion(ticket, input.ifVersion)
  touchBoard(ticket.boardId)
  relocate(ticket, input.column, input.position, actor, input.force)
  bumpVersion(id)
  return getTicket(id)
}

/**
 * Moves every ticket of a column to the end of another column, preserving order.
 * Part of deleting a column, so the done column's pull request requirement doesn't apply.
 */
export function moveAllTickets(fromColumnId: string, toColumnRef: string, actor: string) {
  const from = getColumn(fromColumnId)
  const target = resolveColumn(from.boardId, toColumnRef)
  if (target.id === from.id) throw badRequest('Cannot move tickets into the column being deleted')
  for (const ticket of listTickets(from.boardId, { column: from.id })) {
    moveTicket(ticket.id, { column: target.id, force: true }, actor)
  }
}

export function claimTicket(id: string, input: ClaimTicketInput): Ticket {
  const ticket = getTicket(id)
  assertVersion(ticket, input.ifVersion)
  if (ticket.assignee && ticket.assignee !== input.agent) {
    throw conflict('already_claimed', `Ticket is already claimed by "${ticket.assignee}"`, { ticket })
  }
  touchBoard(ticket.boardId)
  assign(ticket, input.agent, input.agent)
  if (input.moveTo) relocate(ticket, input.moveTo, undefined, input.agent)
  bumpVersion(id)
  return getTicket(id)
}

export function releaseTicket(id: string, input: ReleaseTicketInput): Ticket {
  const ticket = getTicket(id)
  if (ticket.assignee && ticket.assignee !== input.agent && !input.force) {
    throw conflict('claimed_by_other', `Ticket is claimed by "${ticket.assignee}", not "${input.agent}"`, { ticket })
  }
  touchBoard(ticket.boardId)
  assign(ticket, null, input.agent)
  if (input.moveTo) relocate(ticket, input.moveTo, undefined, input.agent)
  bumpVersion(id)
  return getTicket(id)
}

/**
 * Atomically claims the most important unassigned ticket of a column:
 * highest priority first, then earliest due date, then board order.
 */
export function claimNextTicket(boardId: string, input: ClaimNextInput): Ticket {
  touchBoard(boardId)
  const column = resolveColumn(boardId, input.column)
  const tagIds = resolveTags(boardId, input.tags ?? [], { create: false })
  const tagFilter = tagIds.map(() => 'AND EXISTS (SELECT 1 FROM ticket_tags WHERE ticket_id = t.id AND tag_id = ?)')
  const candidate = sql.get<{ id: string }>(
    `SELECT t.id FROM tickets t
     WHERE t.column_id = ? AND t.assignee IS NULL ${tagFilter.join(' ')}
     ORDER BY t.priority DESC, t.due_date IS NULL, t.due_date, t.position
     LIMIT 1`,
    column.id,
    ...tagIds,
  )
  if (!candidate) {
    throw new HttpError(404, 'no_ticket_available', `No unassigned ticket available in "${column.name}"`)
  }
  return claimTicket(candidate.id, { agent: input.agent, moveTo: input.moveTo })
}

/** Atomically links the agent's pull request, assigns the ticket to it and moves it to the review column. */
export function submitForReview(id: string, input: SubmitForReviewInput): Ticket {
  const ticket = getTicket(id)
  assertVersion(ticket, input.ifVersion)
  if (ticket.assignee && ticket.assignee !== input.agent) {
    throw conflict('claimed_by_other', `Ticket is claimed by "${ticket.assignee}", not "${input.agent}"`, { ticket })
  }
  const { review } = workflowColumns(ticket.boardId)
  if (!review) throw badRequest('This board has no review column; choose one in the board settings')

  touchBoard(ticket.boardId)
  linkPullRequest(ticket, input.pullRequest, input.agent)
  assign(ticket, input.agent, input.agent)
  if (ticket.columnId !== review.id) relocate(ticket, review.id, undefined, input.agent)
  if (input.comment) logActivity(id, input.agent, 'comment', { body: input.comment })
  bumpVersion(id)
  return getTicket(id)
}

/** Tickets whose pull request may still change state. */
export function listPendingPullRequests() {
  return sql.all<{ ticketId: string; url: string }>(
    "SELECT id AS ticketId, pr_url AS url FROM tickets WHERE pr_url IS NOT NULL AND pr_state IN ('unknown', 'open', 'draft')",
  )
}

export interface PullRequestStatus {
  state: Exclude<PullRequestState, 'unknown'>
  title: string | null
}

/** Stores a pull request's state without side effects (used when importing). */
export function setPullRequestStatus(ticketId: string, { state, title }: PullRequestStatus) {
  sql.run(
    'UPDATE tickets SET pr_state = ?, pr_title = ?, pr_checked_at = ? WHERE id = ? AND pr_url IS NOT NULL',
    state,
    title,
    now(),
    ticketId,
  )
}

/**
 * Records the latest GitHub state of a ticket's pull request. When it gets merged, the ticket moves to the
 * board's done column. Ignored if the ticket was linked to another pull request in the meantime.
 */
export function applyPullRequestStatus(ticketId: string, url: string, status: PullRequestStatus): Ticket {
  const ticket = getTicket(ticketId)
  const previous = ticket.pullRequest
  // Merged is final on GitHub, so a different state can only be a stale response from an overlapping check.
  if (previous?.url !== url || previous.state === 'merged') return ticket

  setPullRequestStatus(ticketId, status)
  if (previous.state === status.state && previous.title === status.title) return ticket

  touchBoard(ticket.boardId)
  // A first check finding the PR open or draft isn't news; merges and closes always are.
  const firstCheck = previous.state === 'unknown'
  if (previous.state !== status.state && (!firstCheck || status.state === 'merged' || status.state === 'closed')) {
    logActivity(ticketId, GITHUB_ACTOR, 'pull_request', { url, event: status.state })
  }
  const done = workflowColumns(ticket.boardId).done
  if (status.state === 'merged' && done && ticket.columnId !== done.id) {
    relocate(ticket, done.id, undefined, GITHUB_ACTOR, true)
  }
  bumpVersion(ticketId)
  return getTicket(ticketId)
}

export function deleteTicket(id: string) {
  const ticket = getTicket(id)
  touchBoard(ticket.boardId)
  sql.run('DELETE FROM tickets WHERE id = ?', id)
}

export function addComment(id: string, body: string, actor: string) {
  const ticket = getTicket(id)
  touchBoard(ticket.boardId)
  return logActivity(id, actor, 'comment', { body })
}
