import {
  AGENT_IDLE_MINUTES,
  type AgentEffort,
  type Approval,
  type AutoMergeWait,
  CANCELLED_COLUMN,
  type AgentRun,
  type CheckStatus,
  type Column,
  type FailingCheck,
  IN_PROGRESS_COLUMN,
  isWeeklyLimit,
  parsePullRequestUrl,
  PRIORITIES,
  type Priority,
  type PullRequest,
  type PullRequestState,
  needsApproval,
  QUESTION_TAG,
  reserveFor,
  type Ticket,
  type TicketSize,
} from '../../shared/domain.ts'
import { BLOCKED_TAG, parseBlockers } from '../../shared/blockers.ts'
import { parseChecklist, setChecklistItem } from '../../shared/checklist.ts'
import type {
  ApprovePlanInput,
  BulkTicketsInput,
  CheckItemInput,
  ClaimNextInput,
  ClaimTicketInput,
  CreateTicketInput,
  HeartbeatInput,
  ListTicketsQuery,
  MoveTicketInput,
  PostPlanInput,
  ReleaseIdleInput,
  ReleaseTicketInput,
  SubmitForReviewInput,
  UpdateTicketInput,
} from '../../shared/schemas.ts'
import { newId, now, reorder, sql, touchBoard, updateRow, wakeAgent } from '../db.ts'
import { badRequest, conflict, HttpError, notFound } from '../errors.ts'
import { publish } from '../events.ts'
import { logActivity } from './activity.ts'
import { getClaudeUsage } from './claude-usage.ts'
import { getColumn, listColumns, resolveColumn, workflowColumns } from './columns.ts'
import { resolveEpic } from './epics.ts'
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
  agent_effort: AgentEffort | null
  agent_model: string | null
  agent_docker: number | null
  pr_url: string | null
  pr_state: string
  pr_title: string | null
  pr_conflicts: number
  pr_checks: string | null
  pr_head_sha: string | null
  pr_failing_checks: string
  pr_checked_at: string | null
  auto_merge_wait: string | null
  auto_merge_failed: number
  auto_merge_since: string | null
  /** The board's auto_merge setting while the ticket is in its review column; null elsewhere. */
  auto_merge_on: number | null
  agent_seen_at: string | null
  run_started_at: string | null
  run_step: string | null
  run_tokens: number | null
  stop_requested_at: string | null
  stop_requested_by: string | null
  estimate: TicketSize | null
  approval: Approval | null
  routed_model: string | null
  routed_effort: AgentEffort | null
  routed_confidence: number | null
  position: number
  version: number
  moved_at: string
  created_at: string
  updated_at: string
  archive_days: number | null
  parent_id: string | null
  epic_id: string | null
  subtickets_total: number
  subtickets_done: number
  tag_ids: string | null
  comment_count: number
  attachment_count: number
  usage_runs: number
  usage_tokens: number | null
  usage_cost: number | null
  waiting_since: string | null
}

/**
 * When the ticket's agent started waiting for a person: the newest comment on it is from its assignee, or the newest
 * of its comments is its assignee's plan and that waits for approval, while it's worked (not in the review or done
 * column, and its pull request wasn't closed). Null when it isn't waiting. Needs the ticket as `t`.
 */
export const WAITING_SINCE = `
  (SELECT CASE WHEN (a.actor = t.assignee OR a.actor = substr(t.assignee, 1, instr(t.assignee || '/', '/') - 1)
                         OR a.actor = substr(t.assignee, 1, instr(t.assignee || '/', '/') - 1) || '-loop'
                         OR a.actor LIKE substr(t.assignee, 1, instr(t.assignee || '/', '/') - 1) || '/%')
                        AND (a.type = 'comment' OR t.approval = 'pending') THEN a.created_at END
   FROM activity a JOIN boards b ON b.id = t.board_id
   WHERE a.ticket_id = t.id AND a.type IN ('comment', 'plan')
     AND t.column_id IS NOT b.review_column_id AND t.column_id IS NOT b.done_column_id AND t.pr_state != 'closed'
   ORDER BY a.id DESC LIMIT 1)`

/** Sub-tickets of the ticket `t` that count towards its progress: all but cancelled ones. Aliased `c`. */
const SUBTICKETS = `
  FROM tickets c
  WHERE c.parent_id = t.id
    AND c.column_id NOT IN (SELECT id FROM columns WHERE board_id = t.board_id AND lower(name) = '${CANCELLED_COLUMN}')`

/** Whether the sub-ticket `c` is finished: merged, or in the board's done column (its last column if it has none). */
const SUBTICKET_DONE = `
  (c.pr_state = 'merged' OR c.column_id = coalesce(
    (SELECT done_column_id FROM boards WHERE id = t.board_id),
    (SELECT id FROM columns WHERE board_id = t.board_id ORDER BY position DESC LIMIT 1)))`

const SELECT_TICKETS = `
  SELECT t.*,
    (SELECT group_concat(tag_id) FROM ticket_tags WHERE ticket_id = t.id) AS tag_ids,
    (SELECT count(*) FROM activity WHERE ticket_id = t.id AND type = 'comment') AS comment_count,
    (SELECT count(*) FROM attachments WHERE ticket_id = t.id) AS attachment_count,
    (SELECT count(*) FROM token_usage WHERE ticket_id = t.id) AS usage_runs,
    (SELECT sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) FROM token_usage
      WHERE ticket_id = t.id) AS usage_tokens,
    (SELECT sum(cost_usd) FROM token_usage WHERE ticket_id = t.id) AS usage_cost,
    (SELECT model FROM ticket_routes WHERE ticket_id = t.id AND source = 'jev') AS routed_model,
    (SELECT effort FROM ticket_routes WHERE ticket_id = t.id AND source = 'jev') AS routed_effort,
    (SELECT confidence FROM ticket_routes WHERE ticket_id = t.id AND source = 'jev') AS routed_confidence,
    ${WAITING_SINCE} AS waiting_since,
    (SELECT count(*) ${SUBTICKETS}) AS subtickets_total,
    (SELECT count(*) ${SUBTICKETS} AND ${SUBTICKET_DONE}) AS subtickets_done,
    (SELECT archive_done_days FROM boards WHERE id = t.board_id AND done_column_id = t.column_id) AS archive_days,
    (SELECT auto_merge FROM boards WHERE id = t.board_id AND review_column_id = t.column_id) AS auto_merge_on
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
    conflicts: Boolean(row.pr_conflicts),
    checks: row.pr_checks as CheckStatus | null,
    failingChecks: row.pr_checks === 'failing' ? (JSON.parse(row.pr_failing_checks) as FailingCheck[]) : [],
    checkedAt: row.pr_checked_at,
  }
}

type RunRow = Pick<
  TicketRow,
  'agent_seen_at' | 'run_started_at' | 'run_step' | 'run_tokens' | 'stop_requested_at' | 'stop_requested_by'
>

/** The run working a ticket: one has started, hasn't ended, and sent a heartbeat within `AGENT_IDLE_MINUTES`. */
function runOf(row: RunRow): AgentRun | null {
  const { agent_seen_at: seenAt, run_started_at: startedAt, run_step: step, run_tokens: tokens } = row
  if (!startedAt || !seenAt || Date.parse(seenAt) < Date.now() - AGENT_IDLE_MINUTES * 60_000) return null
  const { stop_requested_at: at, stop_requested_by: by } = row
  return { startedAt, seenAt, step, tokens, stopRequested: at && by ? { at, by } : null }
}

/**
 * Why auto-merge waits on the ticket's pull request, as its latest round found, only while that can still apply: the
 * board has auto-merge on, the ticket is in its review column and the pull request is open. So a ticket that moves on,
 * or a board that switches auto-merge off, stops showing it at once, before the next round forgets it.
 */
function autoMergeWaitOf(row: TicketRow): AutoMergeWait | null {
  const open = row.pr_state === 'unknown' || row.pr_state === 'open' || row.pr_state === 'draft'
  if (!row.auto_merge_wait || !row.auto_merge_on || !row.pr_url || !open) return null
  return {
    reason: row.auto_merge_wait,
    failed: row.auto_merge_failed === 1,
    since: row.auto_merge_since ?? row.updated_at,
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
  agentEffort: row.agent_effort,
  agentModel: row.agent_model,
  agentDocker: row.agent_docker === null ? null : row.agent_docker === 1,
  tagIds: row.tag_ids ? row.tag_ids.split(',') : [],
  pullRequest: row.pr_url ? toPullRequest(row.pr_url, row) : null,
  position: row.position,
  version: row.version,
  commentCount: row.comment_count,
  attachmentCount: row.attachment_count,
  usage: { runs: row.usage_runs, tokens: row.usage_tokens ?? 0, costUsd: row.usage_cost },
  run: runOf(row),
  waitingSince: row.waiting_since,
  estimate: row.estimate,
  approval: row.approval,
  jevPick:
    row.routed_model && row.routed_effort
      ? { model: row.routed_model, effort: row.routed_effort, confidence: row.routed_confidence }
      : null,
  movedAt: row.moved_at,
  archived: row.archive_days !== null && Date.parse(row.moved_at) < Date.now() - row.archive_days * DAY_MS,
  autoMergeWait: autoMergeWaitOf(row),
  parentId: row.parent_id,
  subtickets: row.subtickets_total ? { done: row.subtickets_done, total: row.subtickets_total } : null,
  epicId: row.epic_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const DAY_MS = 24 * 60 * 60 * 1000

const priorityRank = (priority: Priority) => PRIORITIES.indexOf(priority)

const EDITABLE_FIELDS = [
  'title',
  'description',
  'priority',
  'dueDate',
  'agentEffort',
  'agentModel',
  'agentDocker',
] as const

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

/** A parent's sub-tickets, in board order. */
export function listSubtickets(id: string): Ticket[] {
  getTicket(id)
  return sql.all<TicketRow>(`${SELECT_TICKETS} WHERE t.parent_id = ? ${BOARD_ORDER}`, id).map(toTicket)
}

/** Resolves a reference to a ticket of the board: its id, or its number (`12` or `#12`). */
function resolveTicket(boardId: string, ref: string): Ticket {
  const number = /^#?(\d+)$/.exec(ref)?.[1]
  const row = sql.get<TicketRow>(`${SELECT_TICKETS} WHERE t.id = ?`, ref)
  const ticket = row ? toTicket(row) : number ? getTicketByNumber(boardId, Number(number)) : getTicket(ref)
  if (ticket.boardId !== boardId) throw badRequest(`Ticket ${ref} is on another board`)
  return ticket
}

/**
 * The id of the ticket `ref` names as the parent of ticket `id` (null for a new ticket), or null for no parent.
 * Throws if that would make a ticket its own ancestor.
 */
function parentFor(boardId: string, id: string | null, ref: string | null): string | null {
  if (ref === null) return null
  const parent = resolveTicket(boardId, ref)
  if (parent.id === id) throw badRequest('A ticket cannot be its own parent')
  for (let ancestor = parent; ancestor.parentId; ancestor = getTicket(ancestor.parentId)) {
    if (ancestor.parentId === id) {
      throw badRequest(`Ticket #${parent.number} is a sub-ticket of this one, so it cannot be its parent`)
    }
  }
  return parent.id
}

/** Whether a ticket has sub-tickets and they are all finished. */
const subticketsFinished = ({ subtickets }: Pick<Ticket, 'subtickets'>) =>
  subtickets !== null && subtickets.done === subtickets.total

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
  if (query.epic === 'none') {
    where.push('t.epic_id IS NULL')
  } else if (query.epic) {
    where.push('t.epic_id = ?')
    params.push(resolveEpic(boardId, query.epic, { create: false })!)
  }
  if (query.priority?.length) {
    where.push(`t.priority IN (${query.priority.map(() => '?').join(', ')})`)
    params.push(...query.priority.map(priorityRank))
  }
  if (query.q) {
    // Escape LIKE's wildcards (and the escape character itself) so the search text matches literally
    const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR ('#' || t.number) = ?)")
    params.push(pattern, pattern, query.q.startsWith('#') ? query.q : `#${query.q}`)
  }

  return sql.all<TicketRow>(`${SELECT_TICKETS} WHERE ${where.join(' AND ')} ${BOARD_ORDER}`, ...params).map(toTicket)
}

/** What a 409 says about the ticket: enough to retry, without the whole ticket. */
function conflictState(ticket: Pick<Ticket, 'version' | 'assignee' | 'columnId'>) {
  return { version: ticket.version, assignee: ticket.assignee, columnId: ticket.columnId }
}

function assertVersion(ticket: Ticket, ifVersion: number | undefined) {
  if (ifVersion !== undefined && ticket.version !== ifVersion) {
    throw conflict(
      'version_conflict',
      `Ticket was modified concurrently (current version ${ticket.version}, expected ${ifVersion})`,
      conflictState(ticket),
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
  if (columnId !== ticket.columnId) {
    sql.run('UPDATE tickets SET column_id = ?, moved_at = ? WHERE id = ?', columnId, now(), ticket.id)
  }
  reorder('tickets', ids)
}

/**
 * Whether `actor` is the agent holding a ticket under the name `assignee`, or another name of the same agent, by the
 * rule the agent loop tells its own names by (`ours` in scripts/agent-loop/board.sh): the agent's own name (the
 * assignee's up to its first "/"), its loop's (`<agent>-loop`) or one of its workers' (`<agent>/<model>/<effort>`).
 */
function isAgentOf(assignee: string, actor: string) {
  const agent = assignee.split('/')[0]
  return actor === assignee || actor === agent || actor === `${agent}-loop` || actor.startsWith(`${agent}/`)
}

/**
 * Wakes the board's agent up (see `wakeAgent`) when `actor` gives feedback on a ticket the agent holds, so its loop
 * starts a run for it now rather than after its idle wait (up to minutes). Called for exactly what the loop counts as
 * feedback in a ticket's activity (`TRIAGE` in scripts/agent-loop/triage.sh): a comment, an approved plan, and a move
 * into the in-progress column, by anyone but the agent itself.
 */
function wakeForFeedback(ticket: Pick<Ticket, 'boardId' | 'assignee'>, actor: string) {
  if (ticket.assignee && !isAgentOf(ticket.assignee, actor)) wakeAgent(ticket.boardId)
}

/** Whether a ticket is tagged as a question (`QUESTION_TAG`), answered in a comment rather than a pull request. */
function isQuestion(ticketId: string) {
  return Boolean(
    sql.get(
      `SELECT 1 FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.ticket_id = ? AND lower(g.name) = ?`,
      ticketId,
      QUESTION_TAG,
    ),
  )
}

/**
 * The board's done column only accepts tickets whose pull request is merged, and without a pull request questions
 * and tickets whose sub-tickets are all finished, unless forced.
 */
function assertCanEnter(
  ticket: Pick<Ticket, 'boardId' | 'pullRequest' | 'subtickets'> & { id: string | null; columnId: string | null },
  target: Column,
  force = false,
) {
  if (force || target.id === ticket.columnId || ticket.pullRequest?.state === 'merged') return
  if (target.id !== workflowColumns(ticket.boardId).done?.id) return
  if (!ticket.pullRequest && (subticketsFinished(ticket) || (ticket.id && isQuestion(ticket.id)))) return
  throw conflict(
    'pull_request_not_merged',
    ticket.pullRequest
      ? `Tickets enter "${target.name}" when their pull request is merged; ${ticket.pullRequest.url} is ${ticket.pullRequest.state}. It will move automatically once merged.`
      : `Tickets enter "${target.name}" only with a merged pull request, or without one as questions (tagged "${QUESTION_TAG}") or once all their sub-tickets are finished. Link one with POST /api/tickets/:id/review.`,
  )
}

function relocate(ticket: Ticket, columnRef: string, position: number | undefined, actor: string, force?: boolean) {
  const target = resolveColumn(ticket.boardId, columnRef)
  assertCanEnter(ticket, target, force)
  place(ticket, target.id, position)
  if (target.id !== ticket.columnId) {
    logActivity(ticket.id, actor, 'moved', { from: getColumn(ticket.columnId).name, to: target.name })
    if (target.name.toLowerCase() === IN_PROGRESS_COLUMN) wakeForFeedback(ticket, actor)
  }
}

/** Assigns the ticket, or with `null` unassigns it: then its plan no longer waits for approval, as no agent waits. */
function assign(ticket: Ticket, assignee: string | null, actor: string) {
  if (ticket.assignee === assignee) return
  sql.run('UPDATE tickets SET assignee = ? WHERE id = ?', assignee, ticket.id)
  if (!assignee && ticket.approval === 'pending') sql.run('UPDATE tickets SET approval = NULL WHERE id = ?', ticket.id)
  if (ticket.assignee) logActivity(ticket.id, actor, 'released', { assignee: ticket.assignee })
  if (assignee) logActivity(ticket.id, actor, 'claimed', { assignee })
}

/** Links (or with `null` unlinks) a pull request. Returns whether the link changed. */
function linkPullRequest(ticket: Ticket, url: string | null, actor: string) {
  const next = url === null ? null : parsePullRequestUrl(url)!.url
  const current = ticket.pullRequest?.url ?? null
  if (next === current) return false
  sql.run(
    `UPDATE tickets SET pr_url = ?, pr_state = 'unknown', pr_title = NULL, pr_conflicts = 0, pr_checks = NULL,
       pr_head_sha = NULL, pr_failing_checks = '[]', pr_checked_at = NULL
     WHERE id = ?`,
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
  assertCanEnter({ id: null, boardId, columnId: null, pullRequest: null, subtickets: null }, column, input.force)
  const parentId = parentFor(boardId, null, input.parent ?? null)
  // A sub-ticket joins its parent's epic unless told otherwise.
  const epicId =
    input.epic !== undefined
      ? resolveEpic(boardId, input.epic, { create: true })
      : parentId && getTicket(parentId).epicId

  const { number } = sql.get<{ number: number }>(
    'UPDATE boards SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number',
    boardId,
  )!
  const { count } = sql.get<{ count: number }>('SELECT count(*) AS count FROM tickets WHERE column_id = ?', column.id)!
  const id = newId()
  const timestamp = now()
  sql.run(
    `INSERT INTO tickets (id, board_id, column_id, number, title, description, priority, assignee, due_date,
       agent_effort, agent_model, agent_docker, parent_id, epic_id, position, moved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    boardId,
    column.id,
    number,
    input.title,
    input.description ?? '',
    priorityRank(input.priority ?? 'none'),
    input.assignee ?? null,
    input.dueDate ?? null,
    input.agentEffort ?? null,
    input.agentModel ?? null,
    input.agentDocker == null ? null : Number(input.agentDocker),
    parentId,
    epicId,
    count,
    timestamp,
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
    agent_effort: has('agentEffort') ? input.agentEffort : undefined,
    agent_model: has('agentModel') ? input.agentModel : undefined,
    agent_docker: has('agentDocker') ? (input.agentDocker == null ? null : Number(input.agentDocker)) : undefined,
  })

  if (input.tags) {
    const tagIds = resolveTags(ticket.boardId, input.tags, { create: true })
    if (tagIds.length !== ticket.tagIds.length || tagIds.some((tagId) => !ticket.tagIds.includes(tagId))) {
      setTags(id, tagIds)
      changed.push('tags')
    }
  }
  if (input.parent !== undefined) {
    const parentId = parentFor(ticket.boardId, id, input.parent)
    if (parentId !== ticket.parentId) {
      updateRow('tickets', id, { parent_id: parentId })
      changed.push('parent')
    }
  }
  if (input.epic !== undefined) {
    const epicId = resolveEpic(ticket.boardId, input.epic, { create: true })
    if (epicId !== ticket.epicId) {
      updateRow('tickets', id, { epic_id: epicId })
      changed.push('epic')
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

/** Checks off or unchecks the checklist item at `index` of the ticket's description, leaving the rest as is. */
export function checkItem(id: string, index: number, input: CheckItemInput, actor: string): Ticket {
  const ticket = getTicket(id)
  assertVersion(ticket, input.ifVersion)
  const item = parseChecklist(ticket.description)[index]
  if (!item) throw notFound('Checklist item', index)
  const checked = input.checked ?? true
  if (item.checked === checked) return ticket

  touchBoard(ticket.boardId)
  updateRow('tickets', id, { description: setChecklistItem(ticket.description, index, checked) })
  logActivity(id, actor, 'checked', { item: item.text, checked })
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

/**
 * Applies the same change to several tickets of a board, in one go (the caller's transaction): all of them change, or
 * none if one can't (e.g. a ticket without a merged pull request moving into the done column, unless `force`).
 * Returns the changed tickets in the order given, or none when they were deleted.
 */
export function bulkUpdateTickets(boardId: string, input: BulkTicketsInput, actor: string): Ticket[] {
  const tickets = [...new Map(input.tickets.map((ref) => resolveTicket(boardId, ref)).map((t) => [t.id, t])).values()]
  if (input.delete) {
    for (const ticket of tickets) deleteTicket(ticket.id)
    return []
  }
  const added = input.addTags?.length ? resolveTags(boardId, input.addTags, { create: true }) : []
  const removed = input.removeTags?.length ? resolveTags(boardId, input.removeTags, { create: false }) : []
  const target = input.moveTo === undefined ? undefined : resolveColumn(boardId, input.moveTo)
  const epic = input.epic === undefined ? undefined : resolveEpic(boardId, input.epic, { create: true })
  return tickets.map((ticket) => {
    const tagIds = [...new Set([...ticket.tagIds, ...added])].filter((tagId) => !removed.includes(tagId))
    updateTicket(
      ticket.id,
      { priority: input.priority, tags: tagIds, epic, agentModel: input.agentModel, agentEffort: input.agentEffort },
      actor,
    )
    if (target && target.id !== ticket.columnId) {
      moveTicket(ticket.id, { column: target.id, force: input.force }, actor)
    }
    return getTicket(ticket.id)
  })
}

export function claimTicket(id: string, input: ClaimTicketInput): Ticket {
  const ticket = getTicket(id)
  assertVersion(ticket, input.ifVersion)
  if (ticket.assignee && ticket.assignee !== input.agent) {
    throw conflict('already_claimed', `Ticket is already claimed by "${ticket.assignee}"`, conflictState(ticket))
  }
  // A ticket the agent already holds stays its own, whatever has come up since.
  if (ticket.assignee !== input.agent) assertClaimable(ticket)
  touchBoard(ticket.boardId)
  assign(ticket, input.agent, input.agent)
  if (input.moveTo) relocate(ticket, input.moveTo, undefined, input.agent)
  bumpVersion(id)
  return getTicket(id)
}

/**
 * The checks `claimNextTicket` applies when it picks a ticket, for claiming a specific one: no new claims while the
 * usage reserve holds agents back (429 `usage_reserve_reached`), and none on a ticket that is blocked (409 `blocked`):
 * tagged `blocked`, waiting for an unfinished ticket (`blocked by #12`), or with unfinished sub-tickets.
 */
function assertClaimable(ticket: Ticket) {
  assertBelowUsageReserve()
  const tagged = sql.get(
    `SELECT 1 FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.ticket_id = ? AND lower(g.name) = ?`,
    ticket.id,
    BLOCKED_TAG,
  )
  const unfinishedSubtickets = sql.get(
    `SELECT 1 FROM tickets t WHERE t.id = ? AND EXISTS (SELECT 1 ${SUBTICKETS} AND NOT ${SUBTICKET_DONE})`,
    ticket.id,
  )
  const reason = tagged
    ? `tagged "${BLOCKED_TAG}"; a person has to remove the tag`
    : waitsForOpenTicket(ticket.boardId, ticket)
      ? 'it waits for a ticket it says it is blocked by, which is not finished yet'
      : unfinishedSubtickets
        ? 'its sub-tickets are not all finished yet'
        : null
  if (reason) throw conflict('blocked', `Ticket is blocked: ${reason}`, conflictState(ticket))
}

export function releaseTicket(id: string, input: ReleaseTicketInput): Ticket {
  const ticket = getTicket(id)
  if (ticket.assignee && ticket.assignee !== input.agent && !input.force) {
    throw conflict(
      'claimed_by_other',
      `Ticket is claimed by "${ticket.assignee}", not "${input.agent}"`,
      conflictState(ticket),
    )
  }
  touchBoard(ticket.boardId)
  assign(ticket, null, input.agent)
  if (input.moveTo) relocate(ticket, input.moveTo, undefined, input.agent)
  bumpVersion(id)
  return getTicket(id)
}

const getRunRow = (id: string) => {
  const row = sql.get<RunRow & { board_id: string }>(
    `SELECT board_id, agent_seen_at, run_started_at, run_step, run_tokens, stop_requested_at, stop_requested_by
     FROM tickets WHERE id = ?`,
    id,
  )
  if (!row) throw notFound('Ticket', id)
  return row
}

/**
 * Notes that an agent is working on the ticket right now, starting a run unless one is going on (see `AgentRun`), and
 * what the run is doing and the tokens it has used if the agent says (it keeps them otherwise). Not a change to the
 * ticket: nothing is logged or bumped, but boards are told when a run starts or its step or tokens change, so they
 * show it. A new run starts without a
 * stop request, even if the run before it went quiet with one.
 */
export function recordHeartbeat(id: string, input: HeartbeatInput) {
  const row = getRunRow(id)
  const run = runOf(row)
  const at = now()
  const step = input.step === undefined ? (run?.step ?? null) : input.step || null
  const tokens = input.tokens ?? run?.tokens ?? null
  sql.run(
    `UPDATE tickets SET agent_seen_at = ?, run_started_at = ?, run_step = ?, run_tokens = ?, stop_requested_at = ?,
       stop_requested_by = ?
     WHERE id = ?`,
    at,
    run?.startedAt ?? at,
    step,
    tokens,
    run?.stopRequested?.at ?? null,
    run?.stopRequested?.by ?? null,
    id,
  )
  if (!run || step !== run.step || tokens !== run.tokens) publish({ boardId: row.board_id })
}

/** Ends the run working the ticket, if any: the agent says it has stopped. Its stop request, if any, goes with it. */
export function endRun(id: string) {
  const row = getRunRow(id)
  if (!row.run_started_at) return
  sql.run(
    `UPDATE tickets SET run_started_at = NULL, run_step = NULL, run_tokens = NULL, stop_requested_at = NULL,
       stop_requested_by = NULL
     WHERE id = ?`,
    id,
  )
  publish({ boardId: row.board_id })
}

/**
 * Asks the agent run working the ticket to stop (see `AgentRun.stopRequested`), logged as `stopped`, and wakes the
 * board's agent. Its loop sees the request at its next check of the ticket, stops the run without losing its session
 * or work, and resumes it once someone gives new feedback, e.g. new instructions in a comment. Asking again before the
 * run has stopped changes nothing. Throws 409 `no_run` when no run is going.
 */
export function requestStop(id: string, actor: string): Ticket {
  const row = getRunRow(id)
  const run = runOf(row)
  if (!run) throw conflict('no_run', 'No agent run is working the ticket, so there is nothing to stop')
  if (run.stopRequested) return getTicket(id)
  touchBoard(row.board_id)
  sql.run('UPDATE tickets SET stop_requested_at = ?, stop_requested_by = ? WHERE id = ?', now(), actor, id)
  logActivity(id, actor, 'stopped', { step: run.step })
  wakeAgent(row.board_id)
  return getTicket(id)
}

/**
 * Tickets of a column no agent is working on: none has sent a heartbeat for them, and nothing has happened on them,
 * for `AGENT_IDLE_MINUTES`. Tickets whose plan waits for approval aren't idle: their agent waits on purpose. In board
 * order.
 */
export function listIdleTickets(columnId: string): Ticket[] {
  getColumn(columnId)
  const since = new Date(Date.now() - AGENT_IDLE_MINUTES * 60_000).toISOString()
  return sql
    .all<TicketRow>(
      `${SELECT_TICKETS}
       WHERE t.column_id = ? AND (t.agent_seen_at IS NULL OR t.agent_seen_at < ?) AND t.approval IS NOT 'pending'
         AND NOT EXISTS (SELECT 1 FROM activity WHERE ticket_id = t.id AND created_at >= ?)
       ORDER BY t.position`,
      columnId,
      since,
      since,
    )
    .map(toTicket)
}

/** Unassigns a column's idle tickets (see `listIdleTickets`) and moves them to another column. Returns them. Tickets that can't enter the target (e.g. no merged pull request for the done column) stay as they are. */
export function releaseIdleTickets(columnId: string, input: ReleaseIdleInput, actor: string): Ticket[] {
  const column = getColumn(columnId)
  const target = resolveColumn(column.boardId, input.moveTo)
  if (target.id === column.id) throw badRequest('Idle tickets must move to another column')
  const released: Ticket[] = []
  for (const ticket of listIdleTickets(columnId)) {
    try {
      assertCanEnter(ticket, target)
    } catch {
      continue
    }
    touchBoard(ticket.boardId)
    assign(ticket, null, actor)
    relocate(ticket, target.id, undefined, actor)
    bumpVersion(ticket.id)
    released.push(getTicket(ticket.id))
  }
  return released
}

/**
 * Turns down claiming new tickets while the usage reserve holds agents back (see `ClaudeUsage.reserveReached`), so the
 * rest of the week or of the current session, or the usage credits once a limit is used up, are left for the user.
 * Only new tickets: those agents already hold go on getting runs.
 */
function assertBelowUsageReserve() {
  const { reserveReached: limit, reserve } = getClaudeUsage()
  if (!limit) return
  const reservePercent = reserveFor(limit, reserve)
  const kept = isWeeklyLimit(limit) ? "the week's Claude usage" : 'the current Claude session'
  const resets = limit.resetsAt ? ` It resets at ${limit.resetsAt}.` : ''
  const why =
    reservePercent === null
      ? `Agents claim no new tickets while ${limit.label} is used up, rather than spend the account's usage credits ` +
        `(agents may spend them if the usage reserve allows it, or go on on their API key if that is allowed). `
      : `Agents claim no new tickets while the rest of ${kept} is kept for people's own work: ` +
        `${limit.label} is at ${Math.round(limit.percent)}%, and its usage reserve starts at ${reservePercent}%. `
  const untilReset = limit.resetsAt ? Math.ceil((Date.parse(limit.resetsAt) - Date.now()) / 1000) : NaN
  const error = new HttpError(
    429,
    'usage_reserve_reached',
    `${why}Tickets agents already hold can still be worked.${resets}`,
    { limit, reservePercent },
  )
  // Until the limit resets; an unknown or past reset time falls back to five minutes.
  error.retryAfter = untilReset > 0 ? untilReset : 300
  throw error
}

/**
 * Atomically claims the most important unassigned ticket of a column:
 * highest priority first, then earliest due date, then board order.
 * Blocked tickets are skipped: tagged `blocked`, waiting for an unfinished ticket (`blocked by #12`), or with
 * unfinished sub-tickets. Nothing is claimed while the usage reserve holds agents back.
 */
export function claimNextTicket(boardId: string, input: ClaimNextInput): Ticket {
  touchBoard(boardId)
  const column = resolveColumn(boardId, input.column)
  // Checked even with nothing to claim, so a missing column shows before there is a ticket that can't be claimed.
  if (input.moveTo) resolveColumn(boardId, input.moveTo)
  assertBelowUsageReserve()
  const tagIds = resolveTags(boardId, input.tags ?? [], { create: false })
  const tagFilter = tagIds.map(() => 'AND EXISTS (SELECT 1 FROM ticket_tags WHERE ticket_id = t.id AND tag_id = ?)')
  const candidates = sql.all<{ id: string; number: number; description: string }>(
    `SELECT t.id, t.number, t.description FROM tickets t
     WHERE t.column_id = ? AND t.assignee IS NULL ${tagFilter.join(' ')}
       AND NOT EXISTS (SELECT 1 FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id
                       WHERE tt.ticket_id = t.id AND lower(g.name) = ?)
       AND NOT EXISTS (SELECT 1 ${SUBTICKETS} AND NOT ${SUBTICKET_DONE})
     ORDER BY t.priority DESC, t.due_date IS NULL, t.due_date, t.position`,
    column.id,
    ...tagIds,
    BLOCKED_TAG,
  )
  const candidate = candidates.find((ticket) => !waitsForOpenTicket(boardId, ticket))
  if (!candidate) {
    throw new HttpError(404, 'no_ticket_available', `No unassigned ticket available in "${column.name}"`)
  }
  return claimTicket(candidate.id, { agent: input.agent, moveTo: input.moveTo })
}

/**
 * Whether a ticket's description names another ticket of the board it waits for (`blocked by #12`) that isn't
 * finished yet: not in the board's done column (its last column if it has none) and without a merged pull request.
 */
function waitsForOpenTicket(boardId: string, ticket: { number: number; description: string }): boolean {
  const numbers = parseBlockers(ticket.description).filter((number) => number !== ticket.number)
  if (!numbers.length) return false
  const done = workflowColumns(boardId).done ?? listColumns(boardId).at(-1)
  return sql
    .all<{ column_id: string; pr_state: string | null }>(
      `SELECT column_id, pr_state FROM tickets WHERE board_id = ? AND number IN (${numbers.map(() => '?').join(', ')})`,
      boardId,
      ...numbers,
    )
    .some((blocker) => blocker.column_id !== done?.id && blocker.pr_state !== 'merged')
}

/** Atomically links the agent's pull request, assigns the ticket to it and moves it to the review column. */
export function submitForReview(id: string, input: SubmitForReviewInput): Ticket {
  const ticket = getTicket(id)
  assertVersion(ticket, input.ifVersion)
  if (ticket.assignee && ticket.assignee !== input.agent) {
    throw conflict(
      'claimed_by_other',
      `Ticket is claimed by "${ticket.assignee}", not "${input.agent}"`,
      conflictState(ticket),
    )
  }
  assertNotHeld(ticket)
  const { review } = workflowColumns(ticket.boardId)
  if (!review) throw badRequest('This board has no review column; choose one in the board settings')
  // Tickets whose sub-tickets are all finished may have nothing left to change.
  if (!input.pullRequest && !ticket.pullRequest && !subticketsFinished(ticket)) {
    if (!isQuestion(id)) {
      throw badRequest(
        `Submit a pull request for review, or tag the ticket "${QUESTION_TAG}" to answer it with a comment instead`,
      )
    }
    if (!input.comment) throw badRequest('Give the answer to the question as the comment')
  }

  touchBoard(ticket.boardId)
  if (input.pullRequest) linkPullRequest(ticket, input.pullRequest, input.agent)
  assign(ticket, input.agent, input.agent)
  if (ticket.columnId !== review.id) relocate(ticket, review.id, undefined, input.agent)
  if (input.comment) logActivity(id, input.agent, 'comment', { body: input.comment })
  bumpVersion(id)
  return getTicket(id)
}

function assertNotHeld(ticket: Ticket) {
  if (ticket.approval === 'pending') {
    throw conflict(
      'awaiting_approval',
      "The ticket's plan waits for approval; don't work it until someone approves it (POST /tickets/:id/approve)",
      conflictState(ticket),
    )
  }
}

/**
 * Records the plan and size estimate the ticket's agent posts before it works the ticket. When the board holds tickets
 * of that size for approval (`approvalSize`), the ticket waits for it, unless its plan was approved before: an
 * approved ticket stays approved when its agent posts a revised plan.
 */
export function postPlan(id: string, input: PostPlanInput): Ticket {
  const ticket = getTicket(id)
  if (ticket.assignee && ticket.assignee !== input.agent) {
    throw conflict(
      'claimed_by_other',
      `Ticket is claimed by "${ticket.assignee}", not "${input.agent}"`,
      conflictState(ticket),
    )
  }
  const { approval_size: approvalSize } = sql.get<{ approval_size: TicketSize | null }>(
    'SELECT approval_size FROM boards WHERE id = ?',
    ticket.boardId,
  )!
  const approved = ticket.approval === 'approved'
  const held = !approved && needsApproval(input.estimate, approvalSize)

  touchBoard(ticket.boardId)
  updateRow('tickets', id, { estimate: input.estimate, approval: approved ? 'approved' : held ? 'pending' : null })
  logActivity(id, input.agent, 'plan', { body: input.plan, estimate: input.estimate, held })
  bumpVersion(id)
  return getTicket(id)
}

/** Approves the plan of a ticket that waits for approval, so its agent goes on to work it. */
export function approvePlan(id: string, input: ApprovePlanInput, actor: string): Ticket {
  const ticket = getTicket(id)
  assertVersion(ticket, input.ifVersion)
  if (ticket.approval !== 'pending') {
    throw conflict('not_awaiting_approval', "The ticket's plan doesn't wait for approval", conflictState(ticket))
  }
  if (ticket.assignee && isAgentOf(ticket.assignee, actor)) {
    throw conflict('own_plan', "The ticket's agent can't approve its own plan; a person has to", conflictState(ticket))
  }
  touchBoard(ticket.boardId)
  updateRow('tickets', id, { approval: 'approved' })
  logActivity(id, actor, 'approved', { estimate: ticket.estimate })
  wakeForFeedback(ticket, actor)
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
  /**
   * Whether it has merge conflicts with its base branch; `null` (or left out) while GitHub is still working it out,
   * which keeps the last known answer.
   */
  conflicts?: boolean | null
  /**
   * Combined status of the checks of its head commit; `null` (or left out) keeps the last known one while the head
   * commit stays the same, as GitHub may not list a commit's checks yet, or they couldn't be read.
   */
  checks?: CheckStatus | null
  /** Its checks that didn't pass, stored along with `checks` (and only kept while they fail). */
  failingChecks?: FailingCheck[]
  /** The head commit its checks are of; another one than before drops the last known checks. */
  headSha?: string | null
}

/**
 * Stores a pull request's state without side effects (used when importing). A closed or merged pull request has no
 * conflicts or checks.
 */
export function setPullRequestStatus(
  ticketId: string,
  { state, title, conflicts, checks, failingChecks, headSha }: PullRequestStatus,
) {
  const open = Number(state === 'open' || state === 'draft')
  const sha = headSha ?? null
  // Known checks stay while the head commit does; a new commit's checks start over.
  const newCommit = '? IS NOT NULL AND pr_head_sha IS NOT ?'
  sql.run(
    `UPDATE tickets SET pr_state = ?, pr_title = ?, pr_conflicts = coalesce(?, pr_conflicts),
       pr_checks = CASE WHEN NOT ? THEN NULL WHEN ? IS NOT NULL THEN ? WHEN ${newCommit} THEN NULL ELSE pr_checks END,
       pr_failing_checks = CASE WHEN NOT ? THEN '[]' WHEN ? IS NOT NULL THEN ? WHEN ${newCommit} THEN '[]'
         ELSE pr_failing_checks END,
       pr_head_sha = CASE WHEN ? THEN coalesce(?, pr_head_sha) END,
       pr_checked_at = ?
     WHERE id = ? AND pr_url IS NOT NULL`,
    state,
    title,
    open ? (conflicts == null ? null : Number(conflicts)) : 0,
    open,
    checks ?? null,
    checks ?? null,
    sha,
    sha,
    open,
    checks ?? null,
    JSON.stringify(checks === 'failing' ? (failingChecks ?? []) : []),
    sha,
    sha,
    open,
    sha,
    now(),
    ticketId,
  )
}

/** What the board knows of the checks of a ticket's pull request: the head commit they are of, and those failing. */
export function pullRequestChecks(ticketId: string): { headSha: string | null; failingChecks: FailingCheck[] } {
  const row = sql.get<Pick<TicketRow, 'pr_head_sha' | 'pr_failing_checks'>>(
    'SELECT pr_head_sha, pr_failing_checks FROM tickets WHERE id = ?',
    ticketId,
  )
  if (!row) throw notFound('Ticket', ticketId)
  return { headSha: row.pr_head_sha, failingChecks: JSON.parse(row.pr_failing_checks) as FailingCheck[] }
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
  const { conflicts, checks, failingChecks } = getTicket(ticketId).pullRequest!
  if (
    previous.state === status.state &&
    previous.title === status.title &&
    previous.conflicts === conflicts &&
    previous.checks === checks &&
    JSON.stringify(previous.failingChecks) === JSON.stringify(failingChecks)
  ) {
    return ticket
  }

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

/** Comments on the ticket. A comment from anyone but the agent holding it wakes the agent up (see `wakeForFeedback`). */
export function addComment(id: string, body: string, actor: string, pullRequestComment?: string) {
  const ticket = getTicket(id)
  touchBoard(ticket.boardId)
  wakeForFeedback(ticket, actor)
  return logActivity(id, actor, 'comment', pullRequestComment ? { body, pullRequestComment } : { body })
}

export const FIX_CONFLICTS_COMMENT =
  'The pull request has merge conflicts with its base branch. Please fix them: rebase the pull request’s branch ' +
  'onto the base branch instead of merging it in, resolve each conflict keeping both sides’ changes, and push with ' +
  '--force-with-lease.'

/**
 * Asks for the merge conflicts of the review column's open pull requests to be fixed, with a comment on each of their
 * tickets: new feedback for the agent that holds it. Wakes the board's agent up. Returns the tickets commented on.
 */
export function requestConflictFixes(boardId: string, actor: string): Ticket[] {
  const review = workflowColumns(boardId).review
  if (!review) throw badRequest('The board has no review column')
  wakeAgent(boardId)
  const tickets = sql
    .all<TicketRow>(
      `${SELECT_TICKETS} WHERE t.column_id = ? AND t.pr_state = 'open' AND t.pr_conflicts = 1 ORDER BY t.position`,
      review.id,
    )
    .map(toTicket)
  for (const ticket of tickets) addComment(ticket.id, FIX_CONFLICTS_COMMENT, actor)
  return tickets.map((ticket) => getTicket(ticket.id))
}
