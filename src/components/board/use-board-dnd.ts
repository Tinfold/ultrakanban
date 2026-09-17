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
import { useCallback, useRef, useState } from 'react'
import { useBoardContext } from './board-context'

type Grouping = Record<string, string[]>
type DragItem = { type: 'ticket' | 'column'; id: string }

const typeOf = (item: { data: { current?: Record<string, unknown> } } | null | undefined) =>
  item?.data.current?.type as DragItem['type'] | undefined

const findColumn = (grouping: Grouping, id: UniqueIdentifier) =>
  String(id) in grouping
    ? String(id)
    : Object.keys(grouping).find((columnId) => grouping[columnId].includes(String(id)))

/**
 * Drag-and-drop for columns and tickets. While a ticket is dragged, a draft grouping tracks where it
 * would land; on drop the move is translated into a position among *all* tickets of the target column
 * (including ones hidden by filters) and committed through an optimistic action.
 */
export function useBoardDnd(grouping: Grouping, reorderable: boolean) {
  const { detail, actions, moveTicket, ticketsById } = useBoardContext()
  const [active, setActive] = useState<DragItem | null>(null)
  const [draft, setDraftState] = useState<Grouping | null>(null)
  const draftRef = useRef<Grouping | null>(null)
  const lastOverId = useRef<UniqueIdentifier | null>(null)

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
      const hits = pointerWithin(args)
      let overId = getFirstCollision(hits.length ? hits : rectIntersection(args), 'id')
      if (overId == null) return lastOverId.current == null ? [] : [{ id: lastOverId.current }]

      const current = draftRef.current ?? grouping
      const columnTickets = current[String(overId)]
      if (columnTickets?.length) {
        // Over a column's empty area: target its closest ticket instead.
        const candidates = containers.filter((c) => columnTickets.includes(String(c.id)))
        overId = closestCenter({ ...args, droppableContainers: candidates })[0]?.id ?? overId
      }
      lastOverId.current = overId
      return [{ id: overId }]
    },
    [grouping],
  )

  const onDragStart = ({ active: dragged }: DragStartEvent) => {
    const type = typeOf(dragged)
    if (!type) return
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
    reset()
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
    dndContextProps: { sensors, collisionDetection, onDragStart, onDragOver, onDragEnd, onDragCancel: reset },
  }
}
