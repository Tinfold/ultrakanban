import { createContext, useContext } from 'react'
import type { BoardDetail, Column, Tag, Ticket } from '@shared/domain'
import type { BoardActions } from '@/hooks/use-board-actions'

export interface BoardContextValue {
  detail: BoardDetail
  actions: BoardActions
  /** Moves a ticket, asking for confirmation when it would bypass the merged pull request requirement. */
  moveTicket: (ticketId: string, columnId: string, position?: number) => void
  ticketsById: Map<string, Ticket>
  columnsById: Map<string, Column>
  tagsById: Map<string, Tag>
  /** Everyone currently assigned to a ticket on this board. */
  assignees: string[]
}

export const BoardContext = createContext<BoardContextValue | null>(null)

export function useBoardContext() {
  const value = useContext(BoardContext)
  if (!value) throw new Error('useBoardContext must be used inside <BoardProvider>')
  return value
}
