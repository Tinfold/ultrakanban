import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GaugeIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import { type HTMLAttributes, useState } from 'react'
import type { Column } from '@shared/domain'
import { ColorPicker } from '@/components/common/ColorPicker'
import { ColorDot } from '@/components/common/TagChip'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useBoardContext } from './board-context'
import { DeleteColumnDialog } from './DeleteColumnDialog'

const WIP_LIMITS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20]

interface ColumnHeaderProps {
  column: Column
  ticketCount: number
  onAddTicket: () => void
  /** Drag handle props from the sortable column. */
  handleProps: HTMLAttributes<HTMLElement>
}

export function ColumnHeader({ column, ticketCount, onAddTicket, handleProps }: ColumnHeaderProps) {
  const { detail, actions } = useBoardContext()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const index = detail.columns.findIndex((other) => other.id === column.id)
  const overLimit = column.wipLimit !== null && ticketCount > column.wipLimit

  const rename = (name: string) => {
    setRenaming(false)
    if (name.trim() && name.trim() !== column.name) void actions.updateColumn(column.id, { name: name.trim() })
  }

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 pr-1.5 pl-3">
      {/* Only this part is the drag handle, so events from menus and dialogs never start a drag. */}
      <div
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2 self-stretch active:cursor-grabbing"
        {...handleProps}
      >
        <ColorDot color={column.color} />
        {renaming ? (
          <Input
            autoFocus
            defaultValue={column.name}
            className="h-7 px-1.5 text-[13px] font-semibold"
            onMouseDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') rename(event.currentTarget.value)
              if (event.key === 'Escape') setRenaming(false)
            }}
            onBlur={(event) => rename(event.currentTarget.value)}
          />
        ) : (
          <h2 className="truncate text-[13px] font-semibold" onDoubleClick={() => setRenaming(true)}>
            {column.name}
          </h2>
        )}
        <span
          className={cn(
            'text-xs text-muted-foreground tabular-nums',
            overLimit && 'font-medium text-red-600 dark:text-red-400',
          )}
          title={column.wipLimit ? `WIP limit: ${column.wipLimit}` : undefined}
        >
          {ticketCount}
          {column.wipLimit !== null && ` / ${column.wipLimit}`}
        </span>
      </div>

      <Button size="icon-xs" variant="ghost" aria-label={`Add ticket to ${column.name}`} onClick={onAddTicket}>
        <PlusIcon />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" aria-label="Column actions">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        {/* Don't restore focus to the trigger: it would immediately blur the rename input. */}
        <DropdownMenuContent align="end" className="w-48" onCloseAutoFocus={(event) => event.preventDefault()}>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <PaletteIcon />
              Color
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <ColorPicker value={column.color} onChange={(color) => actions.updateColumn(column.id, { color })} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <GaugeIcon />
              WIP limit
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={String(column.wipLimit)}
                onValueChange={(value) =>
                  actions.updateColumn(column.id, { wipLimit: value === 'null' ? null : Number(value) })
                }
              >
                <DropdownMenuRadioItem value="null">No limit</DropdownMenuRadioItem>
                {WIP_LIMITS.map((limit) => (
                  <DropdownMenuRadioItem key={limit} value={String(limit)}>
                    {limit}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={index === 0} onSelect={() => actions.moveColumn(column.id, index - 1)}>
            <ArrowLeftIcon />
            Move left
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === detail.columns.length - 1}
            onSelect={() => actions.moveColumn(column.id, index + 1)}
          >
            <ArrowRightIcon />
            Move right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2Icon />
            Delete column
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteColumnDialog column={column} ticketCount={ticketCount} open={deleting} onOpenChange={setDeleting} />
    </header>
  )
}
