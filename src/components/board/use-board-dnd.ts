import {
  closestCenter,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  getFirstCollision,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  type UniqueIdentifier,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { useBoardContext } from './board-context'

type Grouping = Record<string, string[]>
type DragItem = { type: 'ticket' | 'column'; id: string }

const typeOf = (item: { data: { current?: Record<string, unknown> } } | null | undefined) =>
  item?.data.current?.type as DragItem['type'] | undefined

const underPointer = (args: Parameters<CollisionDetection>[0]) => {
  const hits = pointerWithin(args)
  return getFirstCollision(hits.length ? hits : rectIntersection(args), 'id')
}

const findColumn = (grouping: Grouping, id: UniqueIdentifier) =>
  String(id) in grouping
    ? String(id)
    : Object.keys(grouping).find((columnId) => grouping[columnId].includes(String(id)))

/** How close to the board's edge (px) a dragged ticket turns the page, and for how long (ms) it has to stay there. */
const PAGE_EDGE = 40
const PAGE_DWELL = 350
/** Minimum time (ms) between two page turns while the ticket stays at the edge. */
const PAGE_INTERVAL = 800

const snaps = (element: Element) => getComputedStyle(element).scrollSnapType !== 'none'
const columnStep = (scroller: HTMLElement) =>
  (scroller.firstElementChild as HTMLElement).offsetWidth + parseFloat(getComputedStyle(scroller).columnGap)

/**
 * On phones the board shows one column at a time and snaps between them. dnd-kit's auto-scroll would race past
 * several columns as soon as the pointer nears the edge, so there, holding a dragged item at the edge turns the board
 * one column at a time instead.
 */
function useColumnPaging(scrollerRef: RefObject<HTMLElement | null>, dragging: boolean) {
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!dragging || !scroller || !snaps(scroller)) return
    let x: number | undefined
    let enteredAt = 0
    let pagedAt = 0
    const track = (event: TouchEvent | MouseEvent) => {
      x = 'touches' in event ? (event.touches[0]?.clientX ?? x) : event.clientX
    }
    const timer = setInterval(() => {
      const { left, right } = scroller.getBoundingClientRect()
      const direction = x === undefined ? 0 : x < left + PAGE_EDGE ? -1 : x > right - PAGE_EDGE ? 1 : 0
      const now = performance.now()
      if (!direction) {
        enteredAt = 0
        return
      }
      enteredAt ||= now
      if (now - enteredAt < PAGE_DWELL || now - pagedAt < PAGE_INTERVAL) return
      pagedAt = now
      scroller.scrollBy({ left: direction * columnStep(scroller), behavior: 'smooth' })
    }, 50)
    window.addEventListener('touchmove', track, { passive: true })
    window.addEventListener('mousemove', track, { passive: true })
    return () => {
      clearInterval(timer)
      window.removeEventListener('touchmove', track)
      window.removeEventListener('mousemove', track)
    }
  }, [scrollerRef, dragging])

  return { canScroll: (element: Element) => element !== scrollerRef.current || !snaps(element) }
}

/**
 * Drag-and-drop for columns and tickets. While a ticket is dragged, a draft grouping tracks where it
 * would land; on drop the move is translated into a position among *all* tickets of the target column
 * (including ones hidden by filters) and committed through an optimistic action.
 */
export function useBoardDnd(grouping: Grouping, reorderable: boolean, scrollerRef: RefObject<HTMLElement | null>) {
  const { detail, actions, moveTicket, ticketsById } = useBoardContext()
  const [active, setActive] = useState<DragItem | null>(null)
  const [draft, setDraftState] = useState<Grouping | null>(null)
  const draftRef = useRef<Grouping | null>(null)
  const lastOverId = useRef<UniqueIdentifier | null>(null)
  const autoScroll = useColumnPaging(scrollerRef, active !== null)

  const setDraft = (next: Grouping | null) => {
    draftRef.current = next
    setDraftState(next)
  }

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  )

  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const containers = args.droppableContainers
      if (typeOf(args.active) === 'column') {
        return closestCenter({ ...args, droppableContainers: containers.filter((c) => typeOf(c) === 'column') })
      }
      // On phones a ticket lands in the column on screen: next to the edges, where the board turns the page, the
      // pointer would otherwise hit the sliver of the neighbouring column.
      const scroller = scrollerRef.current
      const onScreen =
        scroller && snaps(scroller) ? detail.columns[Math.round(scroller.scrollLeft / columnStep(scroller))] : undefined
      let overId = onScreen ? onScreen.id : underPointer(args)
      if (overId == null) return lastOverId.current == null ? [] : [{ id: lastOverId.current }]

      const current = draftRef.current ?? grouping
      const columnTickets = current[String(overId)]
      if (columnTickets?.length) {
        // Over a column rather than one of its tickets: target its closest ticket instead.
        const candidates = containers.filter((c) => columnTickets.includes(String(c.id)))
        overId = closestCenter({ ...args, droppableContainers: candidates })[0]?.id ?? overId
      }
      lastOverId.current = overId
      return [{ id: overId }]
    },
    [grouping, detail.columns, scrollerRef],
  )

  const onDragStart = ({ active: dragged, activatorEvent }: DragStartEvent) => {
    const type = typeOf(dragged)
    if (!type) return
    // A short buzz tells a long press on a phone that the ticket is now picked up.
    if ('touches' in activatorEvent) navigator.vibrate?.(10)
    setActive({ type, id: String(dragged.id) })
    if (type === 'ticket') setDraft(grouping)
  }

  const onDragOver = ({ active: dragged, over }: DragOverEvent) => {
    const current = draftRef.current
    if (!current || !over || typeOf(dragged) !== 'ticket') return
    const from = findColumn(current, dragged.id)
    const to = findColumn(current, over.id)
    if (!from || !to || from === to) return

    const id = String(dragged.id)
    const target = current[to]
    let index = target.length
    if (typeOf(over) === 'ticket') {
      const draggedRect = dragged.rect.current.translated
      const below = draggedRect && draggedRect.top > over.rect.top + over.rect.height / 2
      index = target.indexOf(String(over.id)) + (below ? 1 : 0)
    }
    setDraft({
      ...current,
      [from]: current[from].filter((ticketId) => ticketId !== id),
      [to]: [...target.slice(0, index), id, ...target.slice(index)],
    })
  }

  const reset = () => {
    setActive(null)
    setDraft(null)
    lastOverId.current = null
  }

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    const current = draftRef.current
    setActive(null)
    lastOverId.current = null
    // React Query hands the optimistic move over on a later tick. Until then the draft keeps the ticket where it was
    // dropped: otherwise it jumps back for a frame and the drop animation scrolls a phone's board to its old column.
    setTimeout(() => setDraft(null))
    if (!over) return

    const id = String(dragged.id)
    if (typeOf(dragged) === 'column') {
      const columnIds = detail.columns.map((column) => column.id)
      const to = columnIds.indexOf(String(over.id))
      if (to !== -1 && to !== columnIds.indexOf(id)) void actions.moveColumn(id, to)
      return
    }

    const ticket = ticketsById.get(id)
    const columnId = current && findColumn(current, id)
    if (!ticket || !current || !columnId) return
    if (!reorderable) {
      if (columnId !== ticket.columnId) moveTicket(id, columnId)
      return
    }

    let visible = current[columnId]
    if (visible.includes(String(over.id))) {
      visible = arrayMove(visible, visible.indexOf(id), visible.indexOf(String(over.id)))
    }
    const index = visible.indexOf(id)
    const columnOrder = detail.tickets
      .filter((other) => other.columnId === columnId)
      .sort((a, b) => a.position - b.position)
      .map((other) => other.id)
    const siblings = columnOrder.filter((otherId) => otherId !== id)
    const before = visible[index - 1]
    const after = visible[index + 1]
    const position = before ? siblings.indexOf(before) + 1 : after ? siblings.indexOf(after) : siblings.length

    const unchanged = columnId === ticket.columnId && columnOrder.indexOf(id) === position
    if (!unchanged) moveTicket(id, columnId, position)
  }

  return {
    active,
    grouping: draft ?? grouping,
    dndContextProps: {
      sensors,
      collisionDetection,
      autoScroll,
      onDragStart,
      onDragOver,
      onDragEnd,
      onDragCancel: reset,
    },
  }
}
