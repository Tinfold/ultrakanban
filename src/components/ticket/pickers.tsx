import { CalendarIcon, CheckIcon, PlusIcon, UserRoundXIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { Priority } from '@shared/domain'
import { ColorDot } from '@/components/common/TagChip'
import { PriorityIcon } from '@/components/common/PriorityIcon'
import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useActor } from '@/hooks/use-actor'
import { parseISODate, toISODate } from '@/lib/format'
import { PRIORITIES_DESC, PRIORITY_LABELS } from '@/lib/priority'
import { cn } from '@/lib/utils'
import { useBoardContext } from '../board/board-context'

/** Every picker takes its trigger element as `children`, so callers control how the value is displayed. */
interface PickerProps<T> {
  value: T
  onChange: (value: T) => void
  children: ReactNode
}

export function ColumnPicker({ value, onChange, children }: PickerProps<string>) {
  const { detail } = useBoardContext()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {detail.columns.map((column) => (
            <DropdownMenuRadioItem key={column.id} value={column.id}>
              <ColorDot color={column.color} />
              <span className="truncate">{column.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function PriorityPicker({ value, onChange, children }: PickerProps<Priority>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as Priority)}>
          {PRIORITIES_DESC.map((priority) => (
            <DropdownMenuRadioItem key={priority} value={priority}>
              <PriorityIcon priority={priority} />
              {PRIORITY_LABELS[priority]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AssigneePicker({ value, onChange, children }: PickerProps<string | null>) {
  const { assignees } = useBoardContext()
  const [actor] = useActor()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const people = [...new Set([actor, ...assignees])]
  const typed = search.trim()
  const canAssignTyped = typed && !people.some((name) => name.toLowerCase() === typed.toLowerCase())

  const select = (next: string | null) => {
    onChange(next)
    setOpen(false)
    setSearch('')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Assign to…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No people found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__unassigned" onSelect={() => select(null)}>
                <UserRoundXIcon className="text-muted-foreground" />
                Unassigned
                {value === null && <CheckIcon className="ml-auto" />}
              </CommandItem>
              {people.map((name) => (
                <CommandItem key={name} value={name} onSelect={() => select(name)}>
                  <UserAvatar name={name} size="xs" />
                  <span className="truncate">{name}</span>
                  {name === actor && <span className="text-xs text-muted-foreground">you</span>}
                  {value === name && <CheckIcon className="ml-auto" />}
                </CommandItem>
              ))}
              {canAssignTyped && (
                <CommandItem value={typed} onSelect={() => select(typed)}>
                  <PlusIcon />
                  Assign to “{typed}”
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function DueDatePicker({ value, onChange, children }: PickerProps<string | null>) {
  const [open, setOpen] = useState(false)
  const select = (next: string | null) => {
    onChange(next)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={value ? parseISODate(value) : undefined}
          defaultMonth={value ? parseISODate(value) : undefined}
          onSelect={(date) => select(date ? toISODate(date) : null)}
        />
        <div className="flex gap-1 border-t p-2">
          <Button size="sm" variant="ghost" onClick={() => select(toISODate(new Date()))}>
            <CalendarIcon />
            Today
          </Button>
          {value && (
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => select(null)}>
              Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function TagPicker({ value, onChange, children }: PickerProps<string[]>) {
  const { detail, actions } = useBoardContext()
  const [search, setSearch] = useState('')
  const typed = search.trim()
  const canCreate = typed && !detail.tags.some((tag) => tag.name.toLowerCase() === typed.toLowerCase())

  const toggle = (tagId: string) =>
    onChange(value.includes(tagId) ? value.filter((id) => id !== tagId) : [...value, tagId])

  const create = async () => {
    const tag = await actions.createTag({ name: typed })
    if (tag) onChange([...value, tag.id])
    setSearch('')
  }

  return (
    <Popover onOpenChange={() => setSearch('')}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Search or create tag…" value={search} onValueChange={setSearch} />
          <CommandList>
            {!canCreate && <CommandEmpty>No tags yet. Type to create one.</CommandEmpty>}
            <CommandGroup>
              {detail.tags.map((tag) => (
                <CommandItem key={tag.id} value={tag.name} onSelect={() => toggle(tag.id)}>
                  <ColorDot color={tag.color} />
                  <span className="truncate">{tag.name}</span>
                  <CheckIcon className={cn('ml-auto', !value.includes(tag.id) && 'invisible')} />
                </CommandItem>
              ))}
              {canCreate && (
                <CommandItem value={`__create ${typed}`} onSelect={create}>
                  <PlusIcon />
                  Create tag “{typed}”
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
