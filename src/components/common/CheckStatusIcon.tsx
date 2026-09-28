import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, type LucideIcon } from 'lucide-react'
import type { CheckStatus } from '@shared/domain'
import { CHECKS_HINTS } from '@/lib/pull-request'
import { cn } from '@/lib/utils'

const ICONS: Record<CheckStatus, { icon: LucideIcon; className: string }> = {
  pending: { icon: CircleDashedIcon, className: 'text-muted-foreground' },
  passing: { icon: CircleCheckIcon, className: 'text-emerald-600 dark:text-emerald-400' },
  failing: { icon: CircleXIcon, className: 'text-red-600 dark:text-red-400' },
}

export function CheckStatusIcon({ status, className }: { status: CheckStatus; className?: string }) {
  const { icon: Icon, className: statusClass } = ICONS[status]
  return <Icon aria-label={CHECKS_HINTS[status]} className={cn('size-4 shrink-0', statusClass, className)} />
}
