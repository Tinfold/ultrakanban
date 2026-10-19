import type { RoutingPick } from '@shared/domain'
import { formatModel } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Shown on a ticket whose model and effort Jev picked, e.g. `Jev 0.82`, with the pick in its tooltip. */
export function JevBadge({ pick, className }: { pick: RoutingPick; className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm border border-violet-500/40 px-1 leading-4 text-violet-600 dark:text-violet-400',
        className,
      )}
      title={`Jev picked ${formatModel(pick.model)} at ${pick.effort} effort${
        pick.confidence === null ? '' : ` with ${Math.round(pick.confidence * 100)}% confidence`
      }`}
    >
      Jev{pick.confidence !== null && ` ${pick.confidence.toFixed(2)}`}
    </span>
  )
}
