import {
  ChartColumnIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  EyeIcon,
  InboxIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  UploadIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { BoardSummary } from '@shared/domain'
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
import { cn } from '@/lib/utils'
import { CreateBoardDialog } from './CreateBoardDialog'

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

function Count({
  icon: Icon,
  count,
  label,
  className,
}: {
  icon: LucideIcon
  count: number
  label: string
  className?: string
}) {
  if (!count) return null
  return (
    <span className={cn('flex shrink-0 items-center gap-0.5 text-xs tabular-nums', className)} title={label}>
      <Icon className="size-3.5!" aria-hidden />
      {count}
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** What on a board needs a person: tickets waiting on them, ready for review, and in the backlog. */
function BoardCounts({ board }: { board: BoardSummary }) {
  return (
    <span className="ml-auto flex items-center gap-2">
      <Count
        icon={MessageCircleQuestionIcon}
        count={board.waitingCount}
        label={`${plural(board.waitingCount, 'ticket')} waiting on you: an agent asks a question or waits for approval of its plan`}
        className="font-medium text-sky-600 dark:text-sky-400"
      />
      <Count
        icon={EyeIcon}
        count={board.reviewCount}
        label={`${plural(board.reviewCount, 'ticket')} ready for review`}
        className="text-emerald-600 dark:text-emerald-400"
      />
      <Count
        icon={InboxIcon}
        count={board.backlogCount}
        label={`${plural(board.backlogCount, 'ticket')} in the backlog`}
        className="text-muted-foreground"
      />
      <span className="text-xs text-muted-foreground tabular-nums" title={plural(board.ticketCount, 'open ticket')}>
        {board.ticketCount}
      </span>
    </span>
  )
}

export function BoardSwitcher({ currentBoardId }: { currentBoardId?: string }) {
  const { data: boards = [] } = useBoards()
  const { importBoard } = useBoardTransfer()
  const [, navigate] = useLocation()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const current = boards.find((board) => board.id === currentBoardId)
  // Tickets waiting on a person on the other boards: this one's show on its cards.
  const waitingElsewhere = boards.reduce(
    (sum, board) => (board.id === currentBoardId ? sum : sum + board.waitingCount),
    0,
  )

  const run = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            className="min-w-0 shrink gap-1.5 px-2 font-semibold"
            aria-label={
              waitingElsewhere
                ? `Switch board (${plural(waitingElsewhere, 'ticket')} on other boards waiting on you)`
                : 'Switch board'
            }
          >
            <span className="truncate">{current?.name ?? 'Boards'}</span>
            {waitingElsewhere > 0 && (
              <span
                className="size-2 shrink-0 rounded-full bg-sky-500"
                title={`${plural(waitingElsewhere, 'ticket')} on other boards waiting on you`}
              />
            )}
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
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
                    <BoardCounts board={board} />
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
