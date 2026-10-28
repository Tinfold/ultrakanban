import {
  type DiffSide,
  type LocalPullRequest,
  type LocalPullRequestComment,
  type LocalPullRequestDetail,
  type LocalPullRequestState,
  localPullRequestUrl,
} from '../../shared/domain.ts'
import type { LocalPullRequestCommentInput } from '../../shared/schemas.ts'
import { newId, now, sql, touchBoard } from '../db.ts'
import { conflict, notFound } from '../errors.ts'
import { getBoard } from './boards.ts'
import { applyPullRequestStatus, getTicket, updateTicket, wakeForFeedback } from './tickets.ts'

interface PullRequestRow {
  id: string
  board_id: string
  number: number
  ticket_id: string | null
  ticket_number: number | null
  title: string
  body: string
  head_branch: string
  base_branch: string
  state: LocalPullRequestState
  author: string
  head_sha: string | null
  base_sha: string | null
  merge_sha: string | null
  closed_by: string | null
  closed_at: string | null
  comment_count: number
  created_at: string
  updated_at: string
}

interface CommentRow {
  id: string
  body: string
  author: string
  path: string | null
  line: number | null
  side: DiffSide | null
  created_at: string
  updated_at: string
}

const SELECT_PULL_REQUESTS = `
  SELECT p.*, t.number AS ticket_number,
    (SELECT count(*) FROM local_pull_request_comments WHERE pull_request_id = p.id) AS comment_count
  FROM local_pull_requests p LEFT JOIN tickets t ON t.id = p.ticket_id`

const toPullRequest = (row: PullRequestRow): LocalPullRequest => ({
  boardId: row.board_id,
  number: row.number,
  url: localPullRequestUrl(row.board_id, row.number),
  ticketId: row.ticket_id,
  ticketNumber: row.ticket_number,
  title: row.title,
  body: row.body,
  head: row.head_branch,
  base: row.base_branch,
  state: row.state,
  author: row.author,
  headSha: row.head_sha,
  baseSha: row.base_sha,
  mergeSha: row.merge_sha,
  closedBy: row.closed_by,
  closedAt: row.closed_at,
  commentCount: row.comment_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toComment = (row: CommentRow): LocalPullRequestComment => ({
  id: row.id,
  body: row.body,
  author: row.author,
  path: row.path,
  line: row.line,
  side: row.side,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

function getRow(boardId: string, number: number) {
  const row = sql.get<PullRequestRow>(`${SELECT_PULL_REQUESTS} WHERE p.board_id = ? AND p.number = ?`, boardId, number)
  if (!row) throw notFound('Local pull request', `${boardId}#${number}`)
  return row
}

/** The board's local pull requests, newest first; only those in `state` when given. */
export function listLocalPullRequests(boardId: string, state?: LocalPullRequestState): LocalPullRequest[] {
  getBoard(boardId)
  return sql
    .all<PullRequestRow>(
      `${SELECT_PULL_REQUESTS} WHERE p.board_id = ? AND (? IS NULL OR p.state = ?) ORDER BY p.number DESC`,
      boardId,
      state ?? null,
      state ?? null,
    )
    .map(toPullRequest)
}

export function getLocalPullRequest(boardId: string, number: number): LocalPullRequestDetail {
  const row = getRow(boardId, number)
  const comments = sql.all<CommentRow>(
    'SELECT * FROM local_pull_request_comments WHERE pull_request_id = ? ORDER BY created_at, rowid',
    row.id,
  )
  // Reading it takes git: the routes fill it in (see `mergeability` in server/local-git.ts).
  return { ...toPullRequest(row), comments: comments.map(toComment), mergeability: null }
}

/** The open local pull requests of every board that has a local repository, to check them for conflicts. */
export function listOpenLocalPullRequests() {
  return sql.all<{ boardId: string; number: number }>(
    `SELECT p.board_id AS boardId, p.number FROM local_pull_requests p JOIN boards b ON b.id = p.board_id
     WHERE p.state = 'open' AND b.local_repo_path IS NOT NULL ORDER BY p.board_id, p.number`,
  )
}

/**
 * Records whether an open local pull request has merge conflicts with its base branch on its ticket, as a GitHub one's
 * are (`PullRequest.conflicts`), so the board shows them and the agent loop and "fix conflicts" find them.
 */
export function recordLocalConflicts(boardId: string, number: number, conflicts: boolean) {
  const row = getRow(boardId, number)
  if (row.state !== 'open' || !row.ticket_id) return
  applyPullRequestStatus(row.ticket_id, localPullRequestUrl(boardId, number), {
    state: 'open',
    title: row.title,
    conflicts,
  })
}

/**
 * Opens a local pull request for the ticket and links it as the ticket's pull request, as `pullRequest` does with a
 * GitHub one. One head branch has one open pull request at a time, and so does one ticket: another would leave the
 * first open but no longer linked, so merging it would merge its changes without moving the ticket.
 */
export function openLocalPullRequest(
  ticketId: string,
  input: { head: string; base: string; title: string; body: string },
  actor: string,
): LocalPullRequestDetail {
  const { boardId } = getTicket(ticketId)
  const open = sql.get<{ number: number; head_branch: string }>(
    `SELECT number, head_branch FROM local_pull_requests
     WHERE board_id = ? AND state = 'open' AND (head_branch = ? OR ticket_id = ?)
     ORDER BY head_branch = ? DESC`,
    boardId,
    input.head,
    ticketId,
    input.head,
  )
  if (open) {
    const message =
      open.head_branch === input.head
        ? `Local pull request #${open.number} is open for "${input.head}" already`
        : `Local pull request #${open.number} is open for this ticket already, from "${open.head_branch}": push to that branch, or close it first`
    throw conflict('pull_request_exists', message, { pullRequest: getLocalPullRequest(boardId, open.number) })
  }
  const { number } = sql.get<{ number: number }>(
    'SELECT coalesce(max(number), 0) + 1 AS number FROM local_pull_requests WHERE board_id = ?',
    boardId,
  )!
  const timestamp = now()
  sql.run(
    `INSERT INTO local_pull_requests (id, board_id, number, ticket_id, title, body, head_branch, base_branch, author,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    boardId,
    number,
    ticketId,
    input.title,
    input.body,
    input.head,
    input.base,
    actor,
    timestamp,
    timestamp,
  )
  updateTicket(ticketId, { pullRequest: localPullRequestUrl(boardId, number) }, actor)
  return getLocalPullRequest(boardId, number)
}

/** Comments on a local pull request. One from anyone but the agent holding its ticket wakes the agent up. */
export function addLocalPullRequestComment(
  boardId: string,
  number: number,
  input: LocalPullRequestCommentInput,
  actor: string,
): LocalPullRequestComment {
  const row = getRow(boardId, number)
  touchBoard(boardId)
  const timestamp = now()
  const id = newId()
  sql.run(
    `INSERT INTO local_pull_request_comments (id, pull_request_id, body, author, path, line, side, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    row.id,
    input.body,
    actor,
    input.path ?? null,
    input.line ?? null,
    input.line === undefined ? null : (input.side ?? 'right'),
    timestamp,
    timestamp,
  )
  sql.run('UPDATE local_pull_requests SET updated_at = ? WHERE id = ?', timestamp, row.id)
  if (row.ticket_id) wakeForFeedback(getTicket(row.ticket_id), actor)
  return toComment(sql.get<CommentRow>('SELECT * FROM local_pull_request_comments WHERE id = ?', id)!)
}

/**
 * Records that an open local pull request was merged or closed, keeping the commits its diff is between. Its ticket,
 * while it links it, takes the same state; a merged one moves to the board's done column, as with GitHub.
 */
export function finishLocalPullRequest(
  boardId: string,
  number: number,
  input: { state: 'merged' | 'closed'; headSha: string | null; baseSha: string | null; mergeSha?: string | null },
  actor: string,
): LocalPullRequestDetail {
  const row = getRow(boardId, number)
  if (row.state !== 'open') throw conflict('pull_request_not_open', `Local pull request #${number} is ${row.state}`)
  touchBoard(boardId)
  const timestamp = now()
  sql.run(
    `UPDATE local_pull_requests SET state = ?, head_sha = ?, base_sha = ?, merge_sha = ?, closed_by = ?, closed_at = ?,
       updated_at = ?
     WHERE id = ?`,
    input.state,
    input.headSha,
    input.baseSha,
    input.mergeSha ?? null,
    actor,
    timestamp,
    timestamp,
    row.id,
  )
  if (row.ticket_id) {
    const url = localPullRequestUrl(boardId, number)
    applyPullRequestStatus(row.ticket_id, url, { state: input.state, title: row.title }, actor)
  }
  return getLocalPullRequest(boardId, number)
}
