import { createContext, useContext } from 'react'

export interface SelectionContextValue {
  /** Whether a click selects a ticket rather than opening it: in select mode, or while any ticket is selected. */
  selecting: boolean
  isSelected: (ticketId: string) => boolean
  /** Toggles a ticket, or with `range` selects every visible ticket from the last one clicked to it. */
  click: (ticketId: string, range: boolean) => void
}

export const SelectionContext = createContext<SelectionContextValue>({
  selecting: false,
  isSelected: () => false,
  click: () => {},
})

export const useSelection = () => useContext(SelectionContext)
