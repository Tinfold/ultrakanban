import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, type LucideIcon } from 'lucide-react'
import type { CheckStatus, FailingCheck } from '@shared/domain'
import { checksHint } from '@/lib/pull-request'
import { cn } from '@/lib/utils'

const ICONS: Record<CheckStatus, { icon: LucideIcon; className: string }> = {
  pending: { icon: CircleDashedIcon, className: 'text-muted-foreground' },
  passing: { icon: CircleCheckIcon, className: 'text-emerald-600 dark:text-emerald-400' },
  failing: { icon: CircleXIcon, className: 'text-red-600 dark:text-red-400' },
}

/** The combined status of a pull request's checks; hovering it names the failing ones. */
export function CheckStatusIcon({
  status,
  failingChecks,
  className,
}: {
  status: CheckStatus
  failingChecks?: FailingCheck[]
  className?: string
}) {
  const { icon: Icon, className: statusClass } = ICONS[status]
  const hint = checksHint(status, failingChecks)
  return (
    <span title={hint} className="inline-flex shrink-0">
      <Icon role="img" aria-label={hint} className={cn('size-4 shrink-0', statusClass, className)} />
    </span>
  )
}
