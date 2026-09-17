import { CheckIcon } from 'lucide-react'
import { COLORS, type Color } from '@shared/domain'
import { swatch } from '@/lib/colors'
import { cn } from '@/lib/utils'

export function ColorPicker({ value, onChange }: { value: Color; onChange: (color: Color) => void }) {
  return (
    <div role="radiogroup" aria-label="Color" className="grid grid-cols-5 gap-1.5 p-1">
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={color === value}
          aria-label={color}
          title={color}
          style={swatch(color)}
          onClick={() => onChange(color)}
          className={cn(
            'flex size-6 items-center justify-center rounded-full bg-(--swatch) text-white outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring',
            color === value && 'ring-2 ring-(--swatch) ring-offset-2 ring-offset-popover',
          )}
        >
          {color === value && <CheckIcon className="size-3.5" strokeWidth={3} />}
        </button>
      ))}
    </div>
  )
}
