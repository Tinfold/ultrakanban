import type { Priority } from '@shared/domain'
import { priorityRank } from '@/lib/priority'
import { cn } from '@/lib/utils'

const BARS = [
  { x: 2, height: 5 },
  { x: 6.5, height: 8 },
  { x: 11, height: 11 },
]

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const iconClass = cn('size-4 shrink-0', className)

  if (priority === 'urgent') {
    return (
      <svg viewBox="0 0 16 16" className={cn(iconClass, 'text-orange-500')} aria-hidden>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
        <rect x="7.1" y="4" width="1.8" height="5" rx=".9" fill="white" />
        <circle cx="8" cy="11.3" r="1" fill="white" />
      </svg>
    )
  }

  if (priority === 'none') {
    return (
      <svg viewBox="0 0 16 16" className={cn(iconClass, 'text-muted-foreground')} aria-hidden>
        {[2.5, 7, 11.5].map((x) => (
          <rect key={x} x={x} y="7.25" width="2.5" height="1.5" rx=".75" fill="currentColor" />
        ))}
      </svg>
    )
  }

  const rank = priorityRank(priority)
  return (
    <svg viewBox="0 0 16 16" className={cn(iconClass, 'text-foreground/80')} aria-hidden>
      {BARS.map(({ x, height }, index) => (
        <rect
          key={x}
          x={x}
          y={13.5 - height}
          width="3"
          height={height}
          rx="1"
          fill="currentColor"
          opacity={index < rank ? 1 : 0.25}
        />
      ))}
    </svg>
  )
}
