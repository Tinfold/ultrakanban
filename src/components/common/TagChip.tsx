import type { Tag } from '@shared/domain'
import { swatch } from '@/lib/colors'
import { cn } from '@/lib/utils'

export function ColorDot({ color, className }: { color: Tag['color']; className?: string }) {
  return <span style={swatch(color)} className={cn('size-2 shrink-0 rounded-full bg-(--swatch)', className)} />
}

export function TagChip({ tag, className }: { tag: Tag; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 max-w-full items-center gap-1.5 rounded-full border bg-background/60 px-2 text-[11px] font-medium text-foreground/80',
        className,
      )}
    >
      <ColorDot color={tag.color} className="size-1.5" />
      <span className="truncate">{tag.name}</span>
    </span>
  )
}
