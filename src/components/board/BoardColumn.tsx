import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { PlusIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Column } from '@shared/domain'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useBoardContext } from './board-context'
import { ColumnHeader } from './ColumnHeader'
import { QuickAddTicket } from './QuickAddTicket'
import { SortableTicketCard } from './TicketCard'

/** Keeps tickets in place while dragging over a column whose order is determined by sorting. */
const staticStrategy = () => null

interface BoardColumnProps {
  column: Column
  ticketIds: string[]
  /** Whether tickets can be reordered by dragging (only in manual sort). */
  reorderable: boolean
  onOpenTicket: (ticketId: string) => void
}

export function BoardColumn({ column, ticketIds, reorderable, onOpenTicket }: BoardColumnProps) {
  const { detail, ticketsById } = useBoardContext()
  const [adding, setAdding] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: column.id,
    data: { type: 'column' },
  })
  const ticketCount = detail.tickets.filter((ticket) => ticket.columnId === column.id).length

  const scrollToEnd = () => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })

  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={column.name}
      className={cn(
        'flex max-h-full w-[calc(100vw-3rem)] shrink-0 snap-center flex-col rounded-xl bg-muted/60 sm:w-72 dark:bg-muted/35',
        isDragging && 'opacity-50',
      )}
    >
      <ColumnHeader
        column={column}
        ticketCount={ticketCount}
        onAddTicket={() => {
          setAdding(true)
          requestAnimationFrame(scrollToEnd)
        }}
        handleProps={{ ...attributes, ...listeners }}
      />
      <div ref={listRef} className="flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2 pb-2">
        <SortableContext items={ticketIds} strategy={reorderable ? verticalListSortingStrategy : staticStrategy}>
          {ticketIds.map((ticketId) => {
            const ticket = ticketsById.get(ticketId)
            return ticket && <SortableTicketCard key={ticketId} ticket={ticket} onOpen={onOpenTicket} />
          })}
        </SortableContext>
        {adding ? (
          <QuickAddTicket columnId={column.id} onClose={() => setAdding(false)} onCreated={scrollToEnd} />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-muted-foreground hover:bg-background/60"
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            Add ticket
          </Button>
        )}
      </div>
    </section>
  )
}
