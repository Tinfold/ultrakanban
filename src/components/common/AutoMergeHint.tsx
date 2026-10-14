import { HourglassIcon, TriangleAlertIcon } from 'lucide-react'
import type { AutoMergeWait } from '@shared/domain'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Why the board's auto-merge hasn't merged the ticket's pull request yet (see `AutoMergeWait`), or that merging it
 * failed, which stands out. `label` goes before the reason where the context doesn't say it is about auto-merge.
 */
export function AutoMergeHint({ wait, label, className }: { wait: AutoMergeWait; label?: string; className?: string }) {
  const Icon = wait.failed ? TriangleAlertIcon : HourglassIcon
  const title = wait.failed
    ? `Auto-merge failed, since ${formatDateTime(wait.since)}; it tries again every minute: ${wait.reason}`
    : `Auto-merge waits to merge it, since ${formatDateTime(wait.since)}: ${wait.reason}`
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1',
        wait.failed ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
        className,
      )}
      title={title}
    >
      <Icon aria-hidden className="shrink-0" />
      <span className="truncate">
        {label}
        {wait.reason}
      </span>
    </span>
  )
}
