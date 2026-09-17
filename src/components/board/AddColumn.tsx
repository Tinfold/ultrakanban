import { PlusIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useBoardContext } from './board-context'

export function AddColumn() {
  const { actions } = useBoardContext()
  const [editing, setEditing] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('name') as HTMLInputElement
    const name = input.value.trim()
    if (!name) return setEditing(false)
    input.value = ''
    await actions.createColumn({ name })
  }

  if (!editing) {
    return (
      <Button
        variant="ghost"
        className="h-11 w-[calc(100vw-3rem)] shrink-0 snap-center justify-start rounded-xl border border-dashed text-muted-foreground sm:w-72"
        onClick={() => setEditing(true)}
      >
        <PlusIcon />
        Add column
      </Button>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="flex h-fit w-[calc(100vw-3rem)] shrink-0 snap-center flex-col gap-2 rounded-xl bg-muted/60 p-2 sm:w-72 dark:bg-muted/35"
    >
      <Input
        name="name"
        autoFocus
        placeholder="Column name"
        onKeyDown={(event) => event.key === 'Escape' && setEditing(false)}
        onBlur={(event) => !event.currentTarget.value.trim() && setEditing(false)}
      />
      <div className="flex justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button type="submit" size="xs" onMouseDown={(event) => event.preventDefault()}>
          Add column
        </Button>
      </div>
    </form>
  )
}
