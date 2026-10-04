import { ArchiveIcon, CircleOffIcon, LayersIcon, ListFilterIcon, UserRoundXIcon, XIcon } from 'lucide-react'
import { PriorityIcon } from '@/components/common/PriorityIcon'
import { ColorDot } from '@/components/common/TagChip'
import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { activeFilterCount, NO_FILTER, type TicketFilter } from '@/lib/board-view'
import { swatch } from '@/lib/colors'
import { PRIORITIES_DESC, PRIORITY_LABELS } from '@/lib/priority'
import { useBoardContext } from './board-context'

const toggle = <T,>(values: T[], value: T) =>
  values.includes(value) ? values.filter((other) => other !== value) : [...values, value]

/** Keeps the menu open so several values can be toggled in a row. */
const keepOpen = (event: Event) => event.preventDefault()

interface FilterMenuProps {
  filter: TicketFilter
  onChange: (filter: TicketFilter) => void
  /** Tickets archived for having been done a while; the menu only offers to show them when there are some. */
  archivedCount: number
  showArchived: boolean
  onShowArchivedChange: (showArchived: boolean) => void
}

export function FilterMenu({ filter, onChange, archivedCount, showArchived, onShowArchivedChange }: FilterMenuProps) {
  const { detail, assignees } = useBoardContext()
  const count = activeFilterCount(filter)
  const epicIds = filter.epicIds ?? []

  return (
    <div className="flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={count ? 'rounded-r-none border-r-0' : ''}>
            <ListFilterIcon />
            <span className="hidden sm:inline">Filter</span>
            {count > 0 && (
              <span className="rounded bg-primary px-1 text-[10px] leading-4 text-primary-foreground tabular-nums">
                {count}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              {PRIORITIES_DESC.map((priority) => (
                <DropdownMenuCheckboxItem
                  key={priority}
                  checked={filter.priorities.includes(priority)}
                  onSelect={keepOpen}
                  onCheckedChange={() => onChange({ ...filter, priorities: toggle(filter.priorities, priority) })}
                >
                  <PriorityIcon priority={priority} />
                  {PRIORITY_LABELS[priority]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Tags</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-48 overflow-y-auto">
              {detail.tags.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">No tags</div>}
              {detail.tags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag.id}
                  checked={filter.tagIds.includes(tag.id)}
                  onSelect={keepOpen}
                  onCheckedChange={() => onChange({ ...filter, tagIds: toggle(filter.tagIds, tag.id) })}
                >
                  <ColorDot color={tag.color} />
                  <span className="truncate">{tag.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Epic</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-52 overflow-y-auto">
              <DropdownMenuCheckboxItem
                checked={epicIds.includes(null)}
                onSelect={keepOpen}
                onCheckedChange={() => onChange({ ...filter, epicIds: toggle(epicIds, null) })}
              >
                <CircleOffIcon className="text-muted-foreground" />
                No epic
              </DropdownMenuCheckboxItem>
              {detail.epics.map((epic) => (
                <DropdownMenuCheckboxItem
                  key={epic.id}
                  checked={epicIds.includes(epic.id)}
                  onSelect={keepOpen}
                  onCheckedChange={() => onChange({ ...filter, epicIds: toggle(epicIds, epic.id) })}
                >
                  <LayersIcon style={swatch(epic.color)} className="text-(--swatch)" />
                  <span className="truncate">{epic.title}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Assignee</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-48 overflow-y-auto">
              <DropdownMenuCheckboxItem
                checked={filter.assignees.includes(null)}
                onSelect={keepOpen}
                onCheckedChange={() => onChange({ ...filter, assignees: toggle(filter.assignees, null) })}
              >
                <UserRoundXIcon className="text-muted-foreground" />
                Unassigned
              </DropdownMenuCheckboxItem>
              {assignees.map((name) => (
                <DropdownMenuCheckboxItem
                  key={name}
                  checked={filter.assignees.includes(name)}
                  onSelect={keepOpen}
                  onCheckedChange={() => onChange({ ...filter, assignees: toggle(filter.assignees, name) })}
                >
                  <UserAvatar name={name} size="xs" />
                  <span className="truncate">{name}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {archivedCount > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={showArchived}
                onSelect={keepOpen}
                onCheckedChange={(checked) => onShowArchivedChange(checked === true)}
              >
                <ArchiveIcon className="text-muted-foreground" />
                Show archived
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{archivedCount}</span>
              </DropdownMenuCheckboxItem>
            </>
          )}
          {count > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onChange(NO_FILTER)}>
                <XIcon />
                Clear filters
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {count > 0 && (
        <Button
          variant="outline"
          size="icon-sm"
          className="rounded-l-none"
          aria-label="Clear filters"
          onClick={() => onChange(NO_FILTER)}
        >
          <XIcon />
        </Button>
      )}
    </div>
  )
}
