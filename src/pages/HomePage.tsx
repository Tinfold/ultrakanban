import { UploadIcon } from 'lucide-react'
import { Redirect } from 'wouter'
import { AppHeader, Logo } from '@/components/app/AppHeader'
import { CreateBoardForm } from '@/components/boards/CreateBoardDialog'
import { Button } from '@/components/ui/button'
import { useBoards } from '@/hooks/queries'
import { useBoardTransfer } from '@/hooks/use-board-transfer'
import { useStoredState } from '@/hooks/use-stored-state'
import { storageKeys } from '@/lib/storage'

export function HomePage() {
  const { data: boards, isPending } = useBoards()
  const [lastBoard] = useStoredState<string | null>(storageKeys.lastBoard, null)
  const { importBoard } = useBoardTransfer()

  if (isPending) return <AppHeader />

  if (boards?.length) {
    const target = boards.find((board) => board.id === lastBoard) ?? boards[0]
    return <Redirect to={`/b/${target.id}`} replace />
  }

  return (
    <>
      <AppHeader />
      <main className="grid flex-1 place-items-center overflow-y-auto p-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 grid justify-items-center gap-2 text-center">
            <Logo />
            <h1 className="text-lg font-semibold tracking-tight">Create your first board</h1>
            <p className="text-sm text-muted-foreground">Organize work for yourself and your agents.</p>
          </div>
          <div className="rounded-xl border bg-card p-5 shadow-xs">
            <CreateBoardForm />
          </div>
          <Button variant="ghost" className="mt-3 w-full text-muted-foreground" onClick={importBoard}>
            <UploadIcon />
            Import a board from file
          </Button>
        </div>
      </main>
    </>
  )
}
