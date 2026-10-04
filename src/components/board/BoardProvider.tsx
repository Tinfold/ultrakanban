import { type ReactNode, useCallback, useMemo, useState } from 'react'
import type { BoardDetail } from '@shared/domain'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useBoardActions } from '@/hooks/use-board-actions'
import { assigneesOf } from '@/lib/board-view'
import { ticketRef } from '@/lib/format'
import { requiresMergedPullRequest } from '@/lib/workflow'
import { BoardContext } from './board-context'

const indexById = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]))

interface PendingMove {
  ticketId: string
  columnId: string
  position?: number
}

export function BoardProvider({ detail, children }: { detail: BoardDetail; children: ReactNode }) {
  const actions = useBoardActions(detail.board.id)
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  const ticketsById = useMemo(() => indexById(detail.tickets), [detail.tickets])
  const columnsById = useMemo(() => indexById(detail.columns), [detail.columns])

  const moveTicket = useCallback(
    (ticketId: string, columnId: string, position?: number) => {
      const ticket = ticketsById.get(ticketId)
      if (ticket && requiresMergedPullRequest(detail, ticket, columnId))
        setPendingMove({ ticketId, columnId, position })
      else void actions.moveTicket(ticketId, columnId, position)
    },
    [detail, ticketsById, actions],
  )

  const value = useMemo(
    () => ({
      detail,
      actions,
      moveTicket,
      ticketsById,
      columnsById,
      tagsById: indexById(detail.tags),
      epicsById: indexById(detail.epics),
      assignees: assigneesOf(detail.tickets),
    }),
    [detail, actions, moveTicket, ticketsById, columnsById],
  )

  const pendingTicket = pendingMove && ticketsById.get(pendingMove.ticketId)
  const pendingColumn = pendingMove && columnsById.get(pendingMove.columnId)

  return (
    <BoardContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={!!pendingTicket}
        onOpenChange={(open) => !open && setPendingMove(null)}
        title={pendingTicket ? `Move ${ticketRef(pendingTicket.number)} to ${pendingColumn?.name} anyway?` : ''}
        description={
          pendingTicket?.pullRequest
            ? `Its pull request is ${pendingTicket.pullRequest.state === 'unknown' ? 'not checked yet' : pendingTicket.pullRequest.state}. Tickets move to ${pendingColumn?.name} automatically when their pull request is merged.`
            : `It has no linked pull request. ${pendingColumn?.name} is meant for tickets whose pull request has been merged.`
        }
        confirmLabel="Move anyway"
        onConfirm={() => {
          if (pendingMove)
            void actions.moveTicket(pendingMove.ticketId, pendingMove.columnId, pendingMove.position, true)
          setPendingMove(null)
        }}
      />
    </BoardContext.Provider>
  )
}
