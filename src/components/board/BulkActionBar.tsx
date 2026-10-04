import {
  ArrowRightIcon,
  CheckIcon,
  CircleOffIcon,
  LayersIcon,
  SignalHighIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { PriorityIcon } from '@/components/common/PriorityIcon'
import { ColorDot } from '@/components/common/TagChip'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { BulkChange } from '@/lib/board-updates'
import { swatch } from '@/lib/colors'
import { PRIORITIES_DESC, PRIORITY_LABELS } from '@/lib/priority'
import { requiresMergedPullRequest } from '@/lib/workflow'
import { useBoardContext } from './board-context'

interface BulkActionBarProps {
  /** The selected tickets, in board order. */
  ticketIds: string[]
  /** Every visible ticket, for "Select all". */
  visibleCount: number
  onSelectAll: () => void
  onClear: () => void
}

/** Moves, tags, sets the priority or epic of, or deletes the selected tickets together. */
export function BulkActionBar({ ticketIds, visibleCount, onSelectAll, onClear }: BulkActionBarProps) {
  const { detail, actions, ticketsById } = useBoardContext()
  const [pendingMove, setPendingMove] = useState<{ columnId: string; count: number } | null>(null)
  const tickets = ticketIds.flatMap((ticketId) => ticketsById.get(ticketId) ?? [])
  const count = tickets.length
  const none = count === 0

  const change = (patch: BulkChange, force?: boolean) => void actions.bulkUpdateTickets(ticketIds, patch, force)
  const move = (columnId: string) => {
    const unmerged = tickets.filter((ticket) => requiresMergedPullRequest(detail, ticket, columnId)).length
    if (unmerged) setPendingMove({ columnId, count: unmerged })
    else change({ moveTo: columnId })
  }
  // The epic all the selected tickets are in (null: none of them is in one), or undefined when they differ.
  const sharedEpic = tickets.every((ticket) => ticket.epicId === tickets[0]?.epicId) ? tickets[0]?.epicId : undefined
  const pendingColumn = pendingMove && detail.columns.find((column) => column.id === pendingMove.columnId)

  return (
    <div
      role="toolbar"
      aria-label="Selected tickets"
      className="fixed inset-x-2 bottom-3 z-40 mx-auto flex w-fit max-w-[calc(100vw-1rem)] items-center gap-1 overflow-x-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg"
    >
      <span className="px-2 text-sm font-medium whitespace-nowrap tabular-nums">
        {none ? 'Select tickets' : `${count} selected`}
      </span>
      {count < visibleCount && (
        <Button variant="ghost" size="sm" onClick={onSelectAll}>
          Select all
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={none} aria-label="Move">
            <ArrowRightIcon />
            <span className="hidden sm:inline">Move</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" className="w-48">
          <DropdownMenuLabel>Move to</DropdownMenuLabel>
          {detail.columns.map((column) => (
            <DropdownMenuItem key={column.id} onSelect={() => move(column.id)}>
              <ColorDot color={column.color} />
              {column.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={none} aria-label="Priority">
            <SignalHighIcon />
            <span className="hidden sm:inline">Priority</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" className="w-44">
          <DropdownMenuLabel>Set priority</DropdownMenuLabel>
          {PRIORITIES_DESC.map((priority) => (
            <DropdownMenuItem key={priority} onSelect={() => change({ priority })}>
              <PriorityIcon priority={priority} />
              {PRIORITY_LABELS[priority]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={none || detail.tags.length === 0} aria-label="Tags">
            <TagIcon />
            <span className="hidden sm:inline">Tags</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" className="max-h-72 w-52 overflow-y-auto">
          <DropdownMenuLabel>Add or remove tags</DropdownMenuLabel>
          {detail.tags.map((tag) => {
            const tagged = tickets.filter((ticket) => ticket.tagIds.includes(tag.id)).length
            const all = tagged === count
            return (
              <DropdownMenuCheckboxItem
                key={tag.id}
                checked={all ? true : tagged > 0 ? 'indeterminate' : false}
                // Stay open, to change several tags in a row.
                onSelect={(event) => {
                  event.preventDefault()
                  change(all ? { removeTagIds: [tag.id] } : { addTagIds: [tag.id] })
                }}
              >
                <ColorDot color={tag.color} />
                <span className="truncate">{tag.name}</span>
                {tagged > 0 && !all && (
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {tagged}/{count}
                  </span>
                )}
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={none || detail.epics.length === 0} aria-label="Epic">
            <LayersIcon />
            <span className="hidden sm:inline">Epic</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" className="max-h-72 w-56 overflow-y-auto">
          <DropdownMenuLabel>Put in epic</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => change({ epicId: null })}>
            <CircleOffIcon className="text-muted-foreground" />
            No epic
            {sharedEpic === null && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
          {detail.epics.map((epic) => (
            <DropdownMenuItem key={epic.id} onSelect={() => change({ epicId: epic.id })}>
              <LayersIcon style={swatch(epic.color)} className="text-(--swatch)" />
              <span className="truncate">{epic.title}</span>
              {sharedEpic === epic.id && <CheckIcon className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="sm"
        disabled={none}
        className="text-destructive hover:text-destructive"
        aria-label="Delete"
        onClick={() => {
          actions.bulkDeleteTickets(ticketIds)
          onClear()
        }}
      >
        <Trash2Icon />
        <span className="hidden sm:inline">Delete</span>
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Stop selecting" title="Stop selecting (Esc)" onClick={onClear}>
        <XIcon />
      </Button>
      <ConfirmDialog
        open={!!pendingMove}
        onOpenChange={(open) => !open && setPendingMove(null)}
        title={`Move ${count === 1 ? 'the ticket' : `${count} tickets`} to ${pendingColumn?.name} anyway?`}
        description={`${pendingMove?.count === count ? (count === 1 ? 'It has' : 'They have') : `${pendingMove?.count} of them have`} no merged pull request. ${pendingColumn?.name} is meant for tickets whose pull request has been merged; they move there automatically once it is.`}
        confirmLabel="Move anyway"
        onConfirm={() => {
          if (pendingMove) change({ moveTo: pendingMove.columnId }, true)
          setPendingMove(null)
        }}
      />
    </div>
  )
}
