import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { useLocation } from 'wouter'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { queryKeys } from '@/hooks/queries'
import { api, errorMessage } from '@/lib/api'

const TEMPLATES = {
  simple: { label: 'Simple', columns: ['To do', 'In progress', 'Done'] },
  software: {
    label: 'Software',
    columns: ['Backlog', 'Todo', 'In progress', 'Review', 'Done'],
    workflow: { reviewColumn: 'Review', doneColumn: 'Done' },
  },
  empty: { label: 'Empty', columns: [] },
} as const

type TemplateKey = keyof typeof TEMPLATES

export function CreateBoardForm({ onCreated }: { onCreated?: () => void }) {
  const queryClient = useQueryClient()
  const [, navigate] = useLocation()
  const [template, setTemplate] = useState<TemplateKey>('software')
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim()
    if (!name) return
    setSaving(true)
    try {
      const selected: { columns: readonly string[]; workflow?: { reviewColumn: string; doneColumn: string } } =
        TEMPLATES[template]
      const board = await api.createBoard({ name, columns: [...selected.columns], ...selected.workflow })
      await queryClient.invalidateQueries({ queryKey: queryKeys.boards })
      onCreated?.()
      navigate(`/b/${board.id}`)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="board-name">Name</Label>
        <Input id="board-name" name="name" autoFocus required placeholder="e.g. Product roadmap" />
      </div>
      <div className="grid gap-2">
        <Label>Columns</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          value={template}
          onValueChange={(value) => value && setTemplate(value as TemplateKey)}
          className="w-full"
        >
          {Object.entries(TEMPLATES).map(([key, { label }]) => (
            <ToggleGroupItem key={key} value={key} className="flex-1">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="min-h-4 text-xs text-muted-foreground">
          {TEMPLATES[template].columns.join(' → ') || 'Start from scratch'}
        </p>
      </div>
      <Button type="submit" disabled={saving}>
        Create board
      </Button>
    </form>
  )
}

export function CreateBoardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New board</DialogTitle>
          <DialogDescription>Boards hold their own columns, tags and tickets.</DialogDescription>
        </DialogHeader>
        <CreateBoardForm onCreated={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
