import { CheckIcon, LayersIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import type { Epic } from '@shared/domain'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { swatch } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { useBoardContext } from './board-context'
import { EpicDialog } from './EpicDialog'

interface EpicBarProps {
  /** The epics the board is filtered to (`null`: tickets in no epic). */
  selected: (string | null)[]
  onSelectedChange: (epicIds: (string | null)[]) => void
}

function EpicProgress({ epic }: { epic: Epic }) {
  const { done, total } = epic.progress
  return (
    <>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-(--swatch)/20" aria-hidden>
        <span
          className="block h-full rounded-full bg-(--swatch)"
          style={{ width: `${total ? (done / total) * 100 : 0}%` }}
        />
      </span>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {done}/{total}
      </span>
    </>
  )
}

/**
 * The board's epics, above its columns: each with its progress. Clicking one shows only its tickets; its menu edits or
 * deletes it. Done epics are tucked away in a menu at the end.
 */
export function EpicBar({ selected, onSelectedChange }: EpicBarProps) {
  const { detail, actions } = useBoardContext()
  const [editing, setEditing] = useState<Epic | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Epic | null>(null)
  const only = (epicId: string) => selected.length === 1 && selected[0] === epicId
  // A done epic the board is filtered to stays in view, to edit it or clear the filter.
  const shown = detail.epics.filter((epic) => !epic.done || selected.includes(epic.id))
  const done = detail.epics.filter((epic) => !shown.includes(epic))
  const select = (epicId: string) => onSelectedChange(only(epicId) ? [] : [epicId])

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b px-4 py-1.5" aria-label="Epics">
      <span className="flex shrink-0 items-center gap-1 pr-1 text-xs text-muted-foreground">
        <LayersIcon className="size-3.5" />
        Epics
      </span>
      {shown.map((epic) => (
        <div
          key={epic.id}
          style={swatch(epic.color)}
          className={cn(
            'group flex h-7 shrink-0 items-center rounded-md border border-l-[3px] border-l-(--swatch) bg-card transition-colors',
            only(epic.id) ? 'border-(--swatch) bg-(--swatch)/10' : selected.includes(epic.id) && 'bg-(--swatch)/10',
          )}
        >
          <button
            type="button"
            aria-pressed={selected.includes(epic.id)}
            title={[epic.title, epic.description.trim()].filter(Boolean).join('\n\n')}
            onClick={() => select(epic.id)}
            className="flex h-full max-w-64 items-center gap-2 rounded-l-md pr-1 pl-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {epic.done && <CheckIcon className="size-3.5 shrink-0 text-(--swatch)" />}
            <span className="truncate">{epic.title}</span>
            <EpicProgress epic={epic} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="mr-0.5 text-muted-foreground"
                aria-label={`${epic.title} menu`}
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setEditing(epic)}>
                <PencilIcon />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(epic)}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}
      {done.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs text-muted-foreground">
              <CheckIcon />
              {done.length} done
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Done epics</DropdownMenuLabel>
            {done.map((epic) => (
              <DropdownMenuItem key={epic.id} onSelect={() => select(epic.id)} style={swatch(epic.color)}>
                <LayersIcon className="text-(--swatch)" />
                <span className="truncate">{epic.title}</span>
                <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                  {epic.progress.done}/{epic.progress.total}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => setCreating(true)}>
        <PlusIcon />
        New epic
      </Button>
      <EpicDialog open={creating} onOpenChange={setCreating} />
      <EpicDialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)} epic={editing ?? undefined} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete the epic “${deleting?.title}”?`}
        description="Its tickets stay on the board, in no epic."
        confirmLabel="Delete epic"
        onConfirm={() => {
          if (deleting) {
            void actions.deleteEpic(deleting.id)
            onSelectedChange(selected.filter((epicId) => epicId !== deleting.id))
          }
          setDeleting(null)
        }}
      />
    </div>
  )
}
