import { useEffect } from 'react'
import { Link } from 'wouter'
import { AppHeader } from '@/components/app/AppHeader'
import { BoardProvider } from '@/components/board/BoardProvider'
import { BoardView } from '@/components/board/BoardView'
import { BoardMenu } from '@/components/boards/BoardMenu'
import { Button } from '@/components/ui/button'
import { useBoard } from '@/hooks/queries'
import { useStoredState } from '@/hooks/use-stored-state'
import { storageKeys } from '@/lib/storage'

export function BoardPage({ boardId }: { boardId: string }) {
  const { data, error, isPending } = useBoard(boardId)
  const [, setLastBoard] = useStoredState<string | null>(storageKeys.lastBoard, null)

  // Saved when the board loads and when its tab gets focus, not on every refetch: `data` changes with each live
  // update, so tabs open on other boards would keep overwriting the board the home page opens.
  const loaded = !!data
  useEffect(() => {
    if (!loaded) return
    const save = () => setLastBoard(boardId)
    save()
    window.addEventListener('focus', save)
    return () => window.removeEventListener('focus', save)
  }, [loaded, boardId, setLastBoard])

  useEffect(() => {
    if (data) document.title = `${data.board.name} · ultrakanban`
  }, [data])

  if (isPending) return <AppHeader boardId={boardId} />

  if (error || !data) {
    return (
      <>
        <AppHeader />
        <div className="grid flex-1 place-content-center justify-items-center gap-3 p-6 text-center">
          <h1 className="text-lg font-semibold">Board not found</h1>
          <p className="text-sm text-muted-foreground">{error?.message ?? 'It may have been deleted.'}</p>
          <Button asChild variant="outline">
            <Link href="/">Go to boards</Link>
          </Button>
        </div>
      </>
    )
  }

  return (
    <BoardProvider detail={data}>
      <AppHeader boardId={boardId}>
        <BoardMenu />
      </AppHeader>
      <BoardView />
    </BoardProvider>
  )
}
