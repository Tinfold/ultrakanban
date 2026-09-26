import { type KeyboardEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useBoardContext } from './board-context'

interface QuickAddTicketProps {
  columnId: string
  onClose: () => void
  onCreated: () => void
}

/** Inline title-only ticket creation; stays open for rapid entry. */
export function QuickAddTicket({ columnId, onClose, onCreated }: QuickAddTicketProps) {
  const { actions } = useBoardContext()
  const [title, setTitle] = useState('')

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed) return onClose()
    setTitle('')
    await actions.createTicket({ title: trimmed, column: columnId })
    onCreated()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <div className="rounded-lg border bg-card p-2 shadow-xs">
      <Textarea
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => !title.trim() && onClose()}
        placeholder="Ticket title"
        rows={2}
        className="min-h-0 resize-none border-0 bg-transparent! p-1 text-base shadow-none focus-visible:ring-0 md:text-[13px]"
      />
      <div className="mt-1 flex items-center justify-end gap-1">
        <Button size="xs" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
          Cancel
        </Button>
        <Button size="xs" onMouseDown={(event) => event.preventDefault()} onClick={submit}>
          Add
        </Button>
      </div>
    </div>
  )
}
