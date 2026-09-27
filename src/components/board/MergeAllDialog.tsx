import { useQueryClient } from '@tanstack/react-query'
import {
  CircleIcon,
  CircleSlashIcon,
  CircleXIcon,
  GitMergeIcon,
  Loader2Icon,
  type LucideIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { MergeMethod, MergePlanItem, MergeRun, MergeRunStep, MergeStepStatus } from '@shared/domain'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { queryKeys, useMergePlan, useMergeRun } from '@/hooks/queries'
import { useStoredState } from '@/hooks/use-stored-state'
import { api, errorMessage } from '@/lib/api'
import { ticketRef } from '@/lib/format'
import { MERGE_METHOD_LABELS } from '@/lib/pull-request'
import { storageKeys } from '@/lib/storage'
import { cn } from '@/lib/utils'
import { useBoardContext } from './board-context'

const STATUS_ICONS: Record<MergeStepStatus, { icon: LucideIcon; className: string; label: string }> = {
  pending: { icon: CircleIcon, className: 'text-muted-foreground', label: 'Waiting' },
  merging: { icon: Loader2Icon, className: 'animate-spin text-muted-foreground', label: 'Merging' },
  merged: { icon: GitMergeIcon, className: 'text-violet-600 dark:text-violet-400', label: 'Merged' },
  skipped: { icon: CircleSlashIcon, className: 'text-muted-foreground', label: 'Skipped' },
  failed: { icon: CircleXIcon, className: 'text-red-600 dark:text-red-400', label: 'Failed' },
}

const refs = (ticketIds: string[], numbers: Map<string, number>) =>
  ticketIds.map((id) => ticketRef(numbers.get(id) ?? 0)).join(', ')

function StepRow({
  item,
  position,
  numbers,
}: {
  item: MergePlanItem | MergeRunStep
  position: number
  numbers: Map<string, number>
}) {
  const step = 'status' in item ? item : null
  const status = step ? STATUS_ICONS[step.status] : null
  const problem = step ? (step.status === 'skipped' || step.status === 'failed' ? step.message : null) : item.skip
  const waiting = !step || step.status === 'pending' || step.status === 'merging'
  // The pull requests it builds on share its files anyway.
  const overlaps = item.overlaps.filter((id) => !item.after.includes(id))

  return (
    <li className="flex gap-3 py-2.5">
      {status ? (
        <status.icon aria-label={status.label} className={cn('mt-0.5 size-4 shrink-0', status.className)} />
      ) : item.skip ? (
        <CircleSlashIcon aria-label="Skipped" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : (
        <span className="mt-px flex size-4.5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums">
          {position}
        </span>
      )}
      <div className={cn('grid min-w-0 flex-1 gap-0.5', item.skip && !step && 'opacity-60')}>
        <p className="flex min-w-0 items-baseline gap-1.5 text-sm">
          <span className="shrink-0 text-muted-foreground tabular-nums">{ticketRef(item.ticketNumber)}</span>
          <span className="truncate font-medium">{item.ticketTitle}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline" title={item.title ?? ''}>
            {item.repo.split('/')[1]}#{item.number}
          </a>
          {item.base && (
            <>
              {' '}
              into <code>{item.base}</code>
            </>
          )}
          {item.after.length > 0 && <> · after {refs(item.after, numbers)}, which it builds on</>}
          {overlaps.length > 0 && <> · shares files with {refs(overlaps, numbers)}</>}
        </p>
        {problem && <p className="text-xs text-muted-foreground">{problem}</p>}
        {!problem && item.warning && waiting && (
          <p className="flex gap-1 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
            {item.warning}
          </p>
        )}
      </div>
    </li>
  )
}

function StepList({ items }: { items: (MergePlanItem | MergeRunStep)[] }) {
  const numbers = new Map(items.map((item) => [item.ticketId, item.ticketNumber]))
  let position = 0
  return (
    <ol className="divide-y">
      {items.map((item) => (
        <StepRow key={item.ticketId} item={item} position={item.skip ? 0 : ++position} numbers={numbers} />
      ))}
    </ol>
  )
}

function runSummary(run: MergeRun) {
  const count = (status: MergeStepStatus) => run.steps.filter((step) => step.status === status).length
  if (run.status === 'running') {
    const handled = run.steps.filter((step) => step.status !== 'pending' && step.status !== 'merging').length
    return `Merging… ${handled} of ${run.steps.length} done`
  }
  return [
    `Merged ${count('merged')}`,
    count('skipped') && `skipped ${count('skipped')}`,
    count('failed') && `failed ${count('failed')}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function MergeAllDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <MergeAll onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

/** Mounted with the dialog's content, so every opening asks GitHub for a fresh plan. */
function MergeAll({ onClose }: { onClose: () => void }) {
  const { detail, columnsById } = useBoardContext()
  const boardId = detail.board.id
  const review = columnsById.get(detail.board.reviewColumnId ?? '')?.name ?? 'review'
  const queryClient = useQueryClient()
  const [startedRunId, setStartedRunId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storedMethod, setMethod] = useStoredState<MergeMethod>(storageKeys.mergeMethod, 'merge')

  const { data: run, isSuccess: runLoaded } = useMergeRun(boardId, true)
  const following = run && (run.status === 'running' || run.id === startedRunId) ? run : null
  const plan = useMergePlan(boardId, runLoaded && !following)
  const methods = plan.data?.methods ?? []
  const method = methods.includes(storedMethod) ? storedMethod : methods[0]
  const mergeable = plan.data?.items.filter((item) => !item.skip).length ?? 0

  const start = async () => {
    if (!method) return
    setStarting(true)
    setError(null)
    try {
      const started = await api.startMergeRun(boardId, method)
      queryClient.setQueryData(queryKeys.mergeRun(boardId), started)
      setStartedRunId(started.id)
    } catch (startError) {
      setError(errorMessage(startError))
    } finally {
      setStarting(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Merge all pull requests</DialogTitle>
        <DialogDescription>
          Merges the open pull requests in {review} one at a time: any that build on another after it, the rest in
          column order. After each merge GitHub checks the others again, and any that conflict by then are skipped so
          their agents can resolve them.
        </DialogDescription>
      </DialogHeader>

      {following ? (
        <StepList items={following.steps} />
      ) : plan.isPending ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Checking the pull requests on GitHub…
        </p>
      ) : plan.isError ? (
        <p className="py-4 text-sm text-destructive">{errorMessage(plan.error)}</p>
      ) : plan.data.items.length ? (
        <StepList items={plan.data.items} />
      ) : (
        <p className="py-4 text-sm text-muted-foreground">There are no open pull requests in {review}.</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <DialogFooter className="items-center">
        {following ? (
          <>
            <p className="mr-auto text-sm text-muted-foreground" aria-live="polite">
              {runSummary(following)}
            </p>
            <Button variant={following.status === 'running' ? 'ghost' : 'default'} onClick={onClose}>
              {following.status === 'running' ? 'Close, keep merging' : 'Done'}
            </Button>
          </>
        ) : (
          <>
            {methods.length > 0 && (
              <Select value={method} onValueChange={(value) => setMethod(value as MergeMethod)}>
                <SelectTrigger aria-label="Merge method" className="sm:mr-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((option) => (
                    <SelectItem key={option} value={option}>
                      {MERGE_METHOD_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!mergeable || !method || starting} onClick={start}>
              {starting ? <Loader2Icon className="animate-spin" /> : <GitMergeIcon />}
              Merge {mergeable === 1 ? '1 pull request' : `${mergeable} pull requests`}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  )
}
