import { type FormEvent, useState } from 'react'
import type { Color, Epic } from '@shared/domain'
import { colorForName } from '@shared/domain'
import { ColorPicker } from '@/components/common/ColorPicker'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useBoardContext } from './board-context'

interface EpicDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The epic to edit; a new one is created when not given. */
  epic?: Epic
  onCreated?: (epic: Epic) => void
}

/** Creates an epic or edits one's title, color and description. */
export function EpicDialog({ open, onOpenChange, epic, onCreated }: EpicDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && <EpicForm epic={epic} onDone={() => onOpenChange(false)} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  )
}

function EpicForm({ epic, onDone, onCreated }: { epic?: Epic; onDone: () => void; onCreated?: (epic: Epic) => void }) {
  const { actions } = useBoardContext()
  const [title, setTitle] = useState(epic?.title ?? '')
  const [description, setDescription] = useState(epic?.description ?? '')
  const [color, setColor] = useState<Color | null>(epic?.color ?? null)
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || saving) return
    setSaving(true)
    const fields = { title: title.trim(), description, color: color ?? colorForName(title.trim()) }
    if (epic) {
      await actions.updateEpic(epic.id, fields)
      setSaving(false)
      onDone()
    } else {
      const created = await actions.createEpic(fields)
      setSaving(false)
      if (created) {
        onCreated?.(created)
        onDone()
      }
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{epic ? 'Edit epic' : 'New epic'}</DialogTitle>
        <DialogDescription>
          An epic groups the tickets of a larger piece of work. It is done once all its tickets are.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="epic-title">Title</Label>
        <Input id="epic-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="epic-description">Description</Label>
        <Textarea
          id="epic-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What it is for, in markdown"
          className="max-h-[40dvh] min-h-24"
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Color</Label>
        <ColorPicker value={color ?? colorForName(title.trim())} onChange={setColor} />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim() || saving}>
          {epic ? 'Save' : 'Create epic'}
        </Button>
      </DialogFooter>
    </form>
  )
}
