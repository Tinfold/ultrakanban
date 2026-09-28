/** Selecting several tickets on the board. */

export interface Selection {
  ids: ReadonlySet<string>
  /** The ticket a shift-click selects from: the last one clicked. */
  anchor: string | null
}

export const emptySelection: Selection = { ids: new Set(), anchor: null }

/**
 * The selection after clicking a ticket: toggles it, or with `range` selects every ticket from the anchor to it in
 * `order` (the visible tickets, column by column), keeping what was already selected.
 */
export function clickTicket(selection: Selection, order: string[], id: string, range: boolean): Selection {
  const ids = new Set(selection.ids)
  const from = selection.anchor ? order.indexOf(selection.anchor) : -1
  const to = order.indexOf(id)
  if (range && from !== -1 && to !== -1) {
    for (const other of order.slice(Math.min(from, to), Math.max(from, to) + 1)) ids.add(other)
  } else if (ids.has(id)) {
    ids.delete(id)
  } else {
    ids.add(id)
  }
  return { ids, anchor: id }
}

/** The selected tickets that are still visible, in `order`: what a bulk action changes. */
export const selectedInOrder = (selection: Selection, order: string[]) => order.filter((id) => selection.ids.has(id))
