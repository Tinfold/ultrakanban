import { ChartColumnIcon, CheckIcon, ChevronsUpDownIcon, PlusIcon, UploadIcon } from 'lucide-react'
import { useState } from 'react'
import { useLocation } from 'wouter'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useBoards } from '@/hooks/queries'
import { useBoardTransfer } from '@/hooks/use-board-transfer'
import { CreateBoardDialog } from './CreateBoardDialog'

export function BoardSwitcher({ currentBoardId }: { currentBoardId?: string }) {
  const { data: boards = [] } = useBoards()
  const { importBoard } = useBoardTransfer()
  const [, navigate] = useLocation()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const current = boards.find((board) => board.id === currentBoardId)

  const run = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" className="min-w-0 shrink gap-1.5 px-2 font-semibold" aria-label="Switch board">
            <span className="truncate">{current?.name ?? 'Boards'}</span>
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <Command>
            <CommandInput placeholder="Find board…" />
            <CommandList>
              <CommandEmpty>No boards found.</CommandEmpty>
              <CommandGroup heading="Boards">
                {boards.map((board) => (
                  <CommandItem
                    key={board.id}
                    value={`${board.name} ${board.id}`}
                    onSelect={() => run(() => navigate(`/b/${board.id}`))}
                  >
                    <span className="truncate">{board.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">{board.ticketCount}</span>
                    <CheckIcon className={board.id === currentBoardId ? '' : 'invisible'} />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem onSelect={() => run(() => navigate('/overview'))}>
                  <ChartColumnIcon />
                  Overview
                </CommandItem>
                <CommandItem onSelect={() => run(() => setCreating(true))}>
                  <PlusIcon />
                  New board
                </CommandItem>
                <CommandItem onSelect={() => run(importBoard)}>
                  <UploadIcon />
                  Import from file…
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <CreateBoardDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}
