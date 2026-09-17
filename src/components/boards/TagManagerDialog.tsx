import { PlusIcon, Trash2Icon } from 'lucide-react'
import type { FormEvent } from 'react'
import type { Tag } from '@shared/domain'
import { useBoardContext } from '@/components/board/board-context'
import { ColorPicker } from '@/components/common/ColorPicker'
import { ColorDot } from '@/components/common/TagChip'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

function TagRow({ tag, usage }: { tag: Tag; usage: number }) {
  const { actions } = useBoardContext()

  const rename = (name: string) => {
    if (name.trim() && name.trim() !== tag.name) void actions.updateTag(tag.id, { name: name.trim() })
  }

  return (
    <li className="flex items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Change color of ${tag.name}`}>
            <ColorDot color={tag.color} className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-1.5">
          <ColorPicker value={tag.color} onChange={(color) => actions.updateTag(tag.id, { color })} />
        </PopoverContent>
      </Popover>
      <Input
        key={tag.name}
        defaultValue={tag.name}
        aria-label="Tag name"
        className="h-8"
        onBlur={(event) => rename(event.currentTarget.value)}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
      />
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {usage} ticket{usage === 1 ? '' : 's'}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${tag.name}`}
        className="text-muted-foreground hover:text-destructive"
        onClick={() => actions.deleteTag(tag.id)}
      >
        <Trash2Icon />
      </Button>
    </li>
  )
}

export function TagManagerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { detail, actions } = useBoardContext()

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('name') as HTMLInputElement
    const name = input.value.trim()
    if (!name) return
    if (await actions.createTag({ name })) input.value = ''
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tags</DialogTitle>
          <DialogDescription>Deleting a tag removes it from every ticket.</DialogDescription>
        </DialogHeader>
        <form onSubmit={create} className="flex gap-2">
          <Input name="name" placeholder="New tag name" className="h-8" />
          <Button type="submit" size="sm" className="h-8">
            <PlusIcon />
            Add
          </Button>
        </form>
        <ul className="-mx-1 grid max-h-[50dvh] gap-1.5 overflow-y-auto px-1">
          {detail.tags.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              usage={detail.tickets.filter((ticket) => ticket.tagIds.includes(tag.id)).length}
            />
          ))}
          {detail.tags.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">No tags yet</li>}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
