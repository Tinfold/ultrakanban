import { GitMergeIcon, Loader2Icon } from 'lucide-react'
import { type SyntheticEvent, useState } from 'react'
import { MERGE_METHODS, type MergeMethod, type Ticket } from '@shared/domain'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStoredState } from '@/hooks/use-stored-state'
import { MERGE_METHOD_LABELS } from '@/lib/pull-request'
import { storageKeys } from '@/lib/storage'
import { useBoardContext } from './board-context'

const stop = (event: SyntheticEvent) => event.stopPropagation()

/** Merges a reviewed ticket's pull request right from its card, after a quick confirmation. */
export function QuickMergeButton({ ticket }: { ticket: Ticket }) {
  const { actions } = useBoardContext()
  const [open, setOpen] = useState(false)
  const [merging, setMerging] = useState(false)
  // Shared with "merge all"; the server falls back to a method the repository allows.
  const [method, setMethod] = useStoredState<MergeMethod>(storageKeys.mergeMethod, 'merge')
  const pullRequest = ticket.pullRequest
  if (!pullRequest) return null
  const name = `${pullRequest.repo.split('/')[1]}#${pullRequest.number}`

  const merge = async () => {
    setMerging(true)
    const merged = await actions.mergeTicket(ticket.id, method)
    setMerging(false)
    if (merged) setOpen(false)
  }

  return (
    // The popover's events bubble through React to the card even though it is portaled: keep them from opening
    // the ticket or starting a drag.
    <div className="-my-1 ml-auto" onClick={stop} onPointerDown={stop} onKeyDown={stop}>
      <Popover open={open} onOpenChange={(next) => !merging && setOpen(next)}>
        <PopoverTrigger asChild>
          <Button
            size="xs"
            variant="outline"
            className="h-5 px-1.5 text-[11px]"
            aria-label={`Merge pull request ${name}`}
            title={`Merge pull request ${name}`}
          >
            <GitMergeIcon />
            Merge
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <div className="grid gap-0.5">
            <p className="font-medium">Merge {name}?</p>
            {pullRequest.title && <p className="truncate text-xs text-muted-foreground">{pullRequest.title}</p>}
          </div>
          <Select value={method} onValueChange={(value) => setMethod(value as MergeMethod)}>
            <SelectTrigger aria-label="Merge method" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MERGE_METHODS.map((option) => (
                <SelectItem key={option} value={option}>
                  {MERGE_METHOD_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" disabled={merging} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={merging} onClick={merge}>
              {merging ? <Loader2Icon className="animate-spin" /> : <GitMergeIcon />}
              Merge
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
