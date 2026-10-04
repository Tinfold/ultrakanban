import { LayersIcon } from 'lucide-react'
import type { Epic } from '@shared/domain'
import { swatch } from '@/lib/colors'
import { cn } from '@/lib/utils'

/** An epic's name in its color, with the epic icon: how tickets show the epic they belong to. */
export function EpicChip({ epic, className }: { epic: Epic; className?: string }) {
  return (
    <span
      style={swatch(epic.color)}
      className={cn(
        'inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-md bg-(--swatch)/12 px-1.5 text-[11px] font-medium text-(--swatch)',
        className,
      )}
      title={`Epic: ${epic.title}`}
    >
      <LayersIcon className="size-3 shrink-0" />
      <span className="truncate">{epic.title}</span>
    </span>
  )
}
