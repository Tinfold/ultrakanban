import type { BoardDetail, Ticket } from '@shared/domain'

/** Whether moving a ticket into a column needs a merged pull request (the board's done column). */
export const requiresMergedPullRequest = (detail: BoardDetail, ticket: Ticket, columnId: string) =>
  columnId === detail.board.doneColumnId && columnId !== ticket.columnId && ticket.pullRequest?.state !== 'merged'
