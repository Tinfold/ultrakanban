import { ListChecksIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { useHotkey } from '@/hooks/use-hotkey'
import type { ViewPrefs } from '@/lib/board-view'
import { FilterMenu } from './FilterMenu'
import { SortMenu } from './SortMenu'

interface BoardToolbarProps {
  query: string
  onQueryChange: (query: string) => void
  prefs: ViewPrefs
  onPrefsChange: (prefs: ViewPrefs) => void
  visibleCount: number
  totalCount: number
  archivedCount: number
  onNewTicket: () => void
  /** Whether clicks select tickets, for bulk actions. */
  selecting: boolean
  onSelectingChange: (selecting: boolean) => void
}

export function BoardToolbar({
  query,
  onQueryChange,
  prefs,
  onPrefsChange,
  visibleCount,
  totalCount,
  archivedCount,
  onNewTicket,
  selecting,
  onSelectingChange,
}: BoardToolbarProps) {
  const searchRef = useRef<HTMLInputElement>(null)
  useHotkey('/', () => searchRef.current?.focus())
  useHotkey('c', onNewTicket)
  useHotkey('x', () => onSelectingChange(!selecting))

  return (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <InputGroup className="h-7 max-w-64 min-w-0 flex-1">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            onQueryChange('')
            event.currentTarget.blur()
          }}
          placeholder="Search tickets"
          aria-label="Search tickets"
        />
        <InputGroupAddon align="inline-end">
          {query ? (
            <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onQueryChange('')}>
              <XIcon />
            </InputGroupButton>
          ) : (
            <Kbd className="hidden sm:inline-flex">/</Kbd>
          )}
        </InputGroupAddon>
      </InputGroup>
      <FilterMenu
        filter={prefs.filter}
        onChange={(filter) => onPrefsChange({ ...prefs, filter })}
        archivedCount={archivedCount}
        showArchived={!!prefs.showArchived}
        onShowArchivedChange={(showArchived) => onPrefsChange({ ...prefs, showArchived })}
      />
      <SortMenu value={prefs.sort} onChange={(sort) => onPrefsChange({ ...prefs, sort })} />
      <Button
        variant={selecting ? 'secondary' : 'outline'}
        size="sm"
        aria-pressed={selecting}
        aria-label="Select tickets"
        title="Select several tickets to change them together (X). Ctrl/⌘-click or shift-click also selects."
        onClick={() => onSelectingChange(!selecting)}
      >
        <ListChecksIcon />
        <span className="hidden sm:inline">Select</span>
      </Button>
      <span className="ml-auto hidden text-xs text-muted-foreground tabular-nums md:inline">
        {visibleCount === totalCount ? `${totalCount} tickets` : `${visibleCount} of ${totalCount} tickets`}
      </span>
      <Button size="sm" className="ml-auto md:ml-0" onClick={onNewTicket} aria-label="New ticket">
        <PlusIcon />
        <span className="hidden sm:inline">New ticket</span>
        <Kbd className="hidden bg-primary-foreground/15 text-primary-foreground sm:inline-flex">C</Kbd>
      </Button>
    </div>
  )
}
