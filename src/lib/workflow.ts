import { type BoardDetail, QUESTION_TAG, type Ticket } from '@shared/domain'

/** Whether a ticket is tagged as a question, answered without a pull request. */
export const isQuestion = (detail: BoardDetail, ticket: Ticket) =>
  detail.tags.some((tag) => ticket.tagIds.includes(tag.id) && tag.name.toLowerCase() === QUESTION_TAG)

/**
 * Whether moving a ticket into a column needs a merged pull request (the board's done column). Questions without a
 * pull request don't.
 */
export const requiresMergedPullRequest = (detail: BoardDetail, ticket: Ticket, columnId: string) =>
  columnId === detail.board.doneColumnId &&
  columnId !== ticket.columnId &&
  ticket.pullRequest?.state !== 'merged' &&
  !(ticket.pullRequest === null && isQuestion(detail, ticket))
