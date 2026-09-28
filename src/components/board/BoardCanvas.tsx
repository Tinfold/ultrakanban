import { DndContext, DragOverlay, MeasuringStrategy } from '@dnd-kit/core'
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useCardKeyboardNav } from '@/hooks/use-card-keyboard-nav'
import { AddColumn } from './AddColumn'
import { useBoardContext } from './board-context'
import { BoardColumn } from './BoardColumn'
import { TicketCard } from './TicketCard'
import { useBoardDnd } from './use-board-dnd'

const measuring = { droppable: { strategy: MeasuringStrategy.Always } }

interface BoardCanvasProps {
  /** Visible ticket ids per column, in display order. */
  grouping: Record<string, string[]>
  reorderable: boolean
  onOpenTicket: (ticketId: string) => void
}

export function BoardCanvas({ grouping, reorderable, onOpenTicket }: BoardCanvasProps) {
  const { detail, ticketsById, columnsById, moveTicket } = useBoardContext()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const dnd = useBoardDnd(grouping, reorderable, scrollerRef)
  const activeTicket = dnd.active?.type === 'ticket' ? ticketsById.get(dnd.active.id) : undefined
  const activeColumn = dnd.active?.type === 'column' ? columnsById.get(dnd.active.id) : undefined
  const columnIds = detail.columns.map((column) => column.id)
  const onCardKeyDown = useCardKeyboardNav(columnIds, dnd.grouping, moveTicket)

  return (
    <DndContext measuring={measuring} {...dnd.dndContextProps}>
      <div
        ref={scrollerRef}
        onKeyDown={onCardKeyDown}
        className="flex h-full snap-x snap-mandatory items-start gap-3 overflow-x-auto overscroll-x-contain px-4 pt-3 pb-4 sm:snap-none"
      >
        <SortableContext items={detail.columns.map((column) => column.id)} strategy={horizontalListSortingStrategy}>
          {detail.columns.map((column) => (
            <BoardColumn
              key={column.id}
              column={column}
              ticketIds={dnd.grouping[column.id] ?? []}
              dropTarget={!!activeTicket && dnd.grouping[column.id]?.includes(activeTicket.id)}
              reorderable={reorderable}
              onOpenTicket={onOpenTicket}
            />
          ))}
        </SortableContext>
        <AddColumn />
      </div>
      {createPortal(
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
          {activeTicket && <TicketCard ticket={activeTicket} overlay />}
          {activeColumn && (
            <div className="flex h-11 w-72 items-center rounded-xl border bg-muted px-3 text-[13px] font-semibold shadow-xl">
              {activeColumn.name}
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}
