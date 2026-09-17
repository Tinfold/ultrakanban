import { BotIcon, DownloadIcon, MoreHorizontalIcon, SettingsIcon, TagsIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useLocation } from 'wouter'
import { useBoardContext } from '@/components/board/board-context'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useBoardTransfer } from '@/hooks/use-board-transfer'
import { api, errorMessage } from '@/lib/api'
import { AgentApiDialog } from './AgentApiDialog'
import { BoardSettingsDialog } from './BoardSettingsDialog'
import { TagManagerDialog } from './TagManagerDialog'

type OpenDialog = 'settings' | 'tags' | 'api' | 'delete' | null

export function BoardMenu() {
  const { detail } = useBoardContext()
  const { exportBoard } = useBoardTransfer()
  const [, navigate] = useLocation()
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const dialogProps = (name: Exclude<OpenDialog, null>) => ({
    open: dialog === name,
    onOpenChange: (open: boolean) => setDialog(open ? name : null),
  })

  const deleteBoard = async () => {
    try {
      await api.deleteBoard(detail.board.id)
      toast.success(`Deleted “${detail.board.name}”`)
      navigate('/', { replace: true })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Board actions">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuItem onSelect={() => setDialog('settings')}>
            <SettingsIcon />
            Board settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('tags')}>
            <TagsIcon />
            Manage tags
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('api')}>
            <BotIcon />
            Agent API
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => exportBoard(detail.board.id)}>
            <DownloadIcon />
            Export to file
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDialog('delete')}>
            <Trash2Icon />
            Delete board
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BoardSettingsDialog {...dialogProps('settings')} />
      <TagManagerDialog {...dialogProps('tags')} />
      <AgentApiDialog {...dialogProps('api')} />
      <ConfirmDialog
        {...dialogProps('delete')}
        title={`Delete “${detail.board.name}”?`}
        description={`All ${detail.tickets.length} tickets, columns and tags will be permanently deleted. Export the board first if you may need it again.`}
        confirmLabel="Delete board"
        onConfirm={deleteBoard}
      />
    </>
  )
}
