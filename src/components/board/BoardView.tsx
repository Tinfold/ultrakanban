import { lazy, Suspense, useCallback, useDeferredValue, useMemo, useState } from 'react'
import { useSearchParams } from 'wouter'
import { useHotkey } from '@/hooks/use-hotkey'
import { useViewPrefs } from '@/hooks/use-view-prefs'
import { activeFilterCount, filterTickets, groupTickets } from '@/lib/board-view'
import { clickTicket, emptySelection, type Selection, selectedInOrder } from '@/lib/selection'
import { cn } from '@/lib/utils'
import { useBoardContext } from './board-context'
import { BoardCanvas } from './BoardCanvas'
import { BoardToolbar } from './BoardToolbar'
import { BulkActionBar } from './BulkActionBar'
import { EpicBar } from './EpicBar'
import { SelectionContext } from './selection-context'

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

  // Visible tickets column by column: what a shift-click selects across and bulk actions apply to.
  const order = useMemo(() => detail.columns.flatMap((column) => grouping[column.id] ?? []), [detail.columns, grouping])
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [selectMode, setSelectMode] = useState(false)
  const selectedIds = useMemo(() => selectedInOrder(selection, order), [selection, order])
  const selecting = selectMode || selectedIds.length > 0
  const clearSelection = useCallback(() => {
    setSelection(emptySelection)
    setSelectMode(false)
  }, [])
  useHotkey('Escape', () => selecting && clearSelection())
  const selectionValue = useMemo(
    () => ({
      selecting,
      isSelected: (ticketId: string) => selection.ids.has(ticketId),
      click: (ticketId: string, range: boolean) =>
        setSelection((current) => clickTicket(current, order, ticketId, range)),
    }),
    [selecting, selection, order],
  )

  const openTicket = useCallback((ticketId: string) => setSearchParams({ [TICKET_PARAM]: ticketId }), [setSearchParams])
  const closeTicket = useCallback(() => setSearchParams({}, { replace: true }), [setSearchParams])

  const filtered = activeFilterCount(prefs.filter) > 0 || deferredQuery.trim() !== ''
  const epicIds = prefs.filter.epicIds ?? []
  // New tickets go in the epic the board is filtered to, so they don't vanish from view.
  const newTicketEpicId = epicIds.length === 1 ? epicIds[0] : null

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
        selecting={selecting}
        onSelectingChange={(on) => (on ? setSelectMode(true) : clearSelection())}
      />
      {detail.epics.length > 0 && (
        <EpicBar
          selected={epicIds}
          onSelectedChange={(selected) => setPrefs({ ...prefs, filter: { ...prefs.filter, epicIds: selected } })}
        />
      )}
      {/* Leaves room for the bulk action bar, so it doesn't cover the last tickets. */}
      <main className={cn('min-h-0 flex-1', selecting && 'pb-14')}>
        {detail.columns.length === 0 && (
          <p className="px-4 pt-4 text-sm text-muted-foreground">Add a column to start organizing tickets.</p>
        )}
        <SelectionContext.Provider value={selectionValue}>
          <BoardCanvas
            grouping={grouping}
            reorderable={prefs.sort === 'manual' && !filtered}
            onOpenTicket={openTicket}
          />
        </SelectionContext.Provider>
      </main>
      {selecting && (
        <BulkActionBar
          ticketIds={selectedIds}
          visibleCount={order.length}
          onSelectAll={() => setSelection({ ids: new Set(order), anchor: null })}
          onClear={clearSelection}
        />
      )}
      <Suspense>
        <TicketDialog ticketId={openTicketId} onClose={closeTicket} />
        {detail.columns.length > 0 && (
          <CreateTicketDialog
            open={creating}
            onOpenChange={setCreating}
            onCreated={openTicket}
            epicId={newTicketEpicId}
          />
        )}
      </Suspense>
    </>
  )
}
