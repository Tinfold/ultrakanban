import type { BoardSummary } from '../../shared/domain.ts'
import { BOARD_EXPORT_FORMAT, type BoardExport } from '../../shared/schemas.ts'
import { listActivity, logActivity } from './activity.ts'
import { createBoard, getBoardDetail, updateBoard } from './boards.ts'
import { createColumn } from './columns.ts'
import { createTag } from './tags.ts'
import { createTicket, setPullRequestStatus, updateTicket } from './tickets.ts'

export function exportBoard(id: string): BoardExport {
  const { board, columns, tags, tickets } = getBoardDetail(id, { archived: true })
  const columnName = new Map(columns.map((column) => [column.id, column.name]))
  const tagName = new Map(tags.map((tag) => [tag.id, tag.name]))
  const index = new Map(tickets.map((ticket, i) => [ticket.id, i]))
  return {
    format: BOARD_EXPORT_FORMAT,
    board: {
      name: board.name,
      description: board.description,
      reviewColumn: board.reviewColumnId ? columnName.get(board.reviewColumnId)! : null,
      doneColumn: board.doneColumnId ? columnName.get(board.doneColumnId)! : null,
    },
    columns: columns.map(({ name, color, wipLimit }) => ({ name, color, wipLimit })),
    tags: tags.map(({ name, color }) => ({ name, color })),
    tickets: tickets.map((ticket) => ({
      title: ticket.title,
      description: ticket.description,
      column: columnName.get(ticket.columnId)!,
      priority: ticket.priority,
      tags: ticket.tagIds.map((tagId) => tagName.get(tagId)!),
      assignee: ticket.assignee,
      dueDate: ticket.dueDate,
      agentEffort: ticket.agentEffort,
      agentModel: ticket.agentModel,
      agentDocker: ticket.agentDocker,
      pullRequest: ticket.pullRequest && {
        url: ticket.pullRequest.url,
        state: ticket.pullRequest.state,
        title: ticket.pullRequest.title,
      },
      comments: listActivity(ticket.id).flatMap((entry) =>
        entry.type === 'comment' ? [{ actor: entry.actor, body: entry.data.body, createdAt: entry.createdAt }] : [],
      ),
      parent: ticket.parentId ? (index.get(ticket.parentId) ?? null) : null,
    })),
  }
}

export function importBoard(data: BoardExport, actor: string): BoardSummary {
  const { reviewColumn, doneColumn, ...details } = data.board
  const board = createBoard(details)
  for (const column of data.columns) createColumn(board.id, column)
  for (const tag of data.tags) createTag(board.id, tag)
  const ids: string[] = []
  for (const { comments, pullRequest, parent: _parent, ...ticket } of data.tickets) {
    const { id } = createTicket(board.id, { ...ticket, pullRequest: pullRequest?.url }, actor)
    ids.push(id)
    if (pullRequest && pullRequest.state !== 'unknown') {
      setPullRequestStatus(id, { state: pullRequest.state, title: pullRequest.title })
    }
    for (const comment of comments) logActivity(id, comment.actor, 'comment', { body: comment.body }, comment.createdAt)
  }
  data.tickets.forEach(({ parent }, i) => {
    if (parent !== null && ids[parent] && parent !== i) updateTicket(ids[i], { parent: ids[parent] }, actor)
  })
  // Configured last so imported tickets can be restored into the done column.
  return updateBoard(board.id, { reviewColumn, doneColumn })
}
