import {
  ChartColumnIcon,
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
  // An empty slot when there are none, so the counts of every board stay in the same columns.
  if (!count) return <span aria-hidden />
  return (
    <span
      className={cn(
        'flex items-center justify-self-end gap-0.5 rounded-full px-1.5 py-px text-xs font-medium tabular-nums',
        className,
      )}
      title={label}
    >
      <Icon className="size-3!" aria-hidden />
      {count}
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** What on a board needs a person: tickets waiting on them, ready for review, and in the backlog. */
function BoardCounts({ board }: { board: BoardSummary }) {
  return (
    <span className="grid shrink-0 grid-cols-[repeat(3,2.75rem)_2rem] items-center gap-1">
      <Count
        icon={MessageCircleQuestionIcon}
        count={board.waitingCount}
        label={`${plural(board.waitingCount, 'ticket')} waiting on you: an agent asks a question or waits for approval of its plan`}
        className="bg-sky-500/15 text-sky-700 dark:text-sky-300"
      />
      <Count
        icon={EyeIcon}
        count={board.reviewCount}
        label={`${plural(board.reviewCount, 'ticket')} ready for review`}
        className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      />
      <Count
        icon={InboxIcon}
        count={board.backlogCount}
        label={`${plural(board.backlogCount, 'ticket')} in the backlog`}
        className="bg-muted text-muted-foreground"
      />
      <span
        className="justify-self-end text-xs text-muted-foreground tabular-nums"
        title={plural(board.ticketCount, 'open ticket')}
      >
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
        <PopoverContent align="start" className="w-96 max-w-[calc(100vw-1rem)] p-0">
          <Command>
            <CommandInput placeholder="Find board…" />
            <CommandList>
              <CommandEmpty>No boards found.</CommandEmpty>
              <CommandGroup heading="Boards">
                {boards.map((board) => (
                  <CommandItem
                    key={board.id}
                    value={`${board.name} ${board.id}`}
                    data-checked={board.id === currentBoardId}
                    onSelect={() => run(() => navigate(`/b/${board.id}`))}
                  >
                    <span className="min-w-0 flex-1 truncate">{board.name}</span>
                    <BoardCounts board={board} />
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
