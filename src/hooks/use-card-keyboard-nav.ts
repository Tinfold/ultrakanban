import type { KeyboardEvent } from 'react'

const cardSelector = (ticketId: string) => `[data-ticket-id="${CSS.escape(ticketId)}"]`

const focusCard = (ticketId: string) => document.querySelector<HTMLElement>(cardSelector(ticketId))?.focus()

/**
 * Moving a card to another column re-parents its DOM node (once optimistically, again once the request
 * settles and the board refetches), which drops browser focus each time. Refocus on every DOM change in
 * that window instead of guessing how many renders it takes to settle.
 */
const focusCardAfterMove = (ticketId: string) => {
  const tryFocus = () => focusCard(ticketId)
  tryFocus()
  const observer = new MutationObserver(tryFocus)
  observer.observe(document.body, { childList: true, subtree: true })
  setTimeout(() => observer.disconnect(), 1000)
}

const ARROW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

/**
 * Arrow keys move focus between ticket cards, staying in the column on up/down and crossing columns
 * (landing near the same row) on left/right. Shift+left/right moves the focused card itself, the way
 * `/` and `c` already move focus and create a ticket without a modifier being free for them.
 */
export function useCardKeyboardNav(
  columnIds: string[],
  grouping: Record<string, string[]>,
  moveTicket: (ticketId: string, columnId: string) => void,
) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (!ARROW_KEYS.includes(event.key)) return
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-ticket-id]')
    if (!card) return
    const { ticketId, columnId } = card.dataset
    if (!ticketId || !columnId) return
    const columnIndex = columnIds.indexOf(columnId)
    const ids = grouping[columnId] ?? []
    const index = ids.indexOf(ticketId)
    event.preventDefault()

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const nextId = ids[event.key === 'ArrowUp' ? index - 1 : index + 1]
      if (nextId) focusCard(nextId)
      return
    }

    const targetColumnId = columnIds[event.key === 'ArrowLeft' ? columnIndex - 1 : columnIndex + 1]
    if (!targetColumnId) return
    if (event.shiftKey) {
      moveTicket(ticketId, targetColumnId)
      focusCardAfterMove(ticketId)
      return
    }
    const targetIds = grouping[targetColumnId] ?? []
    const nextId = targetIds[Math.min(index === -1 ? 0 : index, targetIds.length - 1)]
    if (nextId) focusCard(nextId)
  }
}
