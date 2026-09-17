import { type ComponentProps, useState } from 'react'
import { cn } from '@/lib/utils'

interface TitleInputProps extends Omit<ComponentProps<'textarea'>, 'value' | 'onChange'> {
  value: string
  onCommit: (title: string) => void
}

/** Large borderless title that grows with its content and saves on blur or Enter. */
export function TitleInput({ value, onCommit, className, ...props }: TitleInputProps) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : value

  const commit = () => {
    setEditing(false)
    const title = draft.trim()
    if (title && title !== value) onCommit(title)
  }

  return (
    <textarea
      {...props}
      rows={1}
      value={shown}
      aria-label="Title"
      onFocus={() => {
        setDraft(value)
        setEditing(true)
      }}
      onChange={(event) => setDraft(event.target.value.replace(/\n/g, ' '))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === 'Escape' && draft !== value) {
          event.stopPropagation()
          setDraft(value)
        }
      }}
      className={cn(
        'field-sizing-content w-full resize-none bg-transparent text-xl leading-snug font-semibold tracking-tight outline-none placeholder:text-muted-foreground sm:text-2xl',
        className,
      )}
    />
  )
}
