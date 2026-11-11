import type { LucideIcon } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react'
import { sideTabIds } from '@/lib/side-tabs'
import { cn } from '@/lib/utils'

export interface SideTab<T extends string> {
  id: T
  label: string
  icon: LucideIcon
}

interface SideTabsProps<T extends string> {
  tabs: readonly SideTab<T>[]
  active: T
  onSelect: (id: T) => void
  /** Prefix of the tabs' and panels' ids (see `sideTabIds`). */
  idPrefix: string
  label: string
  /** Shown after a tab's label, such as a count or whether its feature is on. */
  badges?: Partial<Record<T, ReactNode>>
  className?: string
}

/**
 * A vertical tab list beside its panels, as in board settings; on narrow screens a row on top that scrolls sideways.
 * Arrow keys, Home and End move between the tabs, and only the active one is in the tab order.
 */
export function SideTabs<T extends string>({
  tabs,
  active,
  onSelect,
  idPrefix,
  label,
  badges,
  className,
}: SideTabsProps<T>) {
  const nav = useRef<HTMLElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const index = tabs.findIndex(({ id }) => id === active)

  // On narrow screens the row scrolls sideways to show the active tab, also when tabs change size later (such as when
  // their badges load). Only the row scrolls, never the page around it.
  useEffect(() => {
    const row = nav.current
    const tab = buttons.current[index]
    if (!row || !tab) return
    const reveal = () => {
      const style = getComputedStyle(row)
      const bounds = row.getBoundingClientRect()
      const { left, right } = tab.getBoundingClientRect()
      const start = bounds.left + parseFloat(style.paddingLeft)
      const end = bounds.right - parseFloat(style.paddingRight)
      if (left < start) row.scrollLeft -= start - left
      else if (right > end) row.scrollLeft += right - end
    }
    const observer = new ResizeObserver(reveal)
    for (const button of buttons.current) if (button) observer.observe(button)
    return () => observer.disconnect()
  }, [index])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : step
            ? (index + step + tabs.length) % tabs.length
            : null
    if (next === null) return
    event.preventDefault()
    onSelect(tabs[next].id)
    buttons.current[next]?.focus()
  }

  return (
    <nav
      ref={nav}
      role="tablist"
      aria-label={label}
      aria-orientation="vertical"
      className={cn(
        'flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0',
        className,
      )}
    >
      {tabs.map(({ id, label, icon: Icon }, index) => {
        const ids = sideTabIds(idPrefix, id)
        return (
          <button
            key={id}
            ref={(element) => {
              buttons.current[index] = element
            }}
            id={ids.tab}
            type="button"
            role="tab"
            aria-selected={active === id}
            aria-controls={ids.panel}
            tabIndex={active === id ? 0 : -1}
            onClick={() => onSelect(id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
              active === id && 'bg-muted font-medium text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="flex-1">{label}</span>
            {badges?.[id]}
          </button>
        )
      })}
    </nav>
  )
}
