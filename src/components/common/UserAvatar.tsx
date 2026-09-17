import { colorForName } from '@shared/domain'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { swatch } from '@/lib/colors'
import { cn } from '@/lib/utils'

const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')

export function UserAvatar({
  name,
  size = 'sm',
  className,
}: {
  name: string
  size?: 'xs' | 'sm' | 'default'
  className?: string
}) {
  return (
    <Avatar size={size === 'xs' ? 'sm' : size} className={cn(size === 'xs' && 'size-5', className)} title={name}>
      <AvatarFallback
        style={swatch(colorForName(name))}
        className={cn('bg-(--swatch)/20 font-semibold text-(--swatch)', size === 'xs' ? 'text-[9px]!' : 'text-[10px]!')}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
}
