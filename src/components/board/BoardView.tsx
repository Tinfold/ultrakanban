import { lazy, Suspense, useCallback, useDeferredValue, useMemo, useState } from 'react'
import { useSearchParams } from 'wouter'
import { useViewPrefs } from '@/hooks/use-view-prefs'
import { activeFilterCount, filterTickets, groupTickets } from '@/lib/board-view'
import { useBoardContext } from './board-context'
import { BoardCanvas } from './BoardCanvas'
import { BoardToolbar } from './BoardToolbar'

const TICKET_PARAM = 'ticket'

// The rich text editor is heavy; load it after the board has rendered.
const TicketDialog = lazy(() => import('@/components/ticket/TicketDialog').then((m) => ({ default: m.TicketDialog })))
const CreateTicketDialog = lazy(() =>
  import('@/components/ticket/CreateTicketDialog').then((m) => ({ default: m.CreateTicketDialog })),
)

export function BoardView() {
  const { detail, tagsById } = useBoardContext()
  const [prefs, setPrefs] = useViewPrefs(detail.board.id)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [creating, setCreating] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const openTicketId = searchParams.get(TICKET_PARAM)

  const visible = useMemo(
    () => filterTickets(detail.tickets, prefs.filter, deferredQuery, tagsById, prefs.showArchived),
    [detail.tickets, prefs.filter, deferredQuery, tagsById, prefs.showArchived],
  )
  const archivedCount = useMemo(() => detail.tickets.filter((ticket) => ticket.archived).length, [detail.tickets])
  const grouping = useMemo(() => groupTickets(detail, visible, prefs.sort), [detail, visible, prefs.sort])

  const openTicket = useCallback((ticketId: string) => setSearchParams({ [TICKET_PARAM]: ticketId }), [setSearchParams])
  const closeTicket = useCallback(() => setSearchParams({}, { replace: true }), [setSearchParams])

  const filtered = activeFilterCount(prefs.filter) > 0 || deferredQuery.trim() !== ''

  return (
    <>
      <BoardToolbar
        query={query}
        onQueryChange={setQuery}
        prefs={prefs}
        onPrefsChange={setPrefs}
        visibleCount={visible.length}
        totalCount={detail.tickets.length - (prefs.showArchived ? 0 : archivedCount)}
        archivedCount={archivedCount}
        onNewTicket={() => setCreating(true)}
      />
      <main className="min-h-0 flex-1">
        {detail.columns.length === 0 && (
          <p className="px-4 pt-4 text-sm text-muted-foreground">Add a column to start organizing tickets.</p>
        )}
        <BoardCanvas grouping={grouping} reorderable={prefs.sort === 'manual' && !filtered} onOpenTicket={openTicket} />
      </main>
      <Suspense>
        <TicketDialog ticketId={openTicketId} onClose={closeTicket} />
        {detail.columns.length > 0 && (
          <CreateTicketDialog open={creating} onOpenChange={setCreating} onCreated={openTicket} />
        )}
      </Suspense>
    </>
  )
}
