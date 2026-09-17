import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { useLocation } from 'wouter'
import { api, errorMessage } from '@/lib/api'
import { pickFiles } from '@/lib/files'
import { queryKeys } from './queries'

function download(filename: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: filename })
  link.click()
  URL.revokeObjectURL(url)
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'board'

/** Save boards to / load boards from portable JSON files. */
export function useBoardTransfer() {
  const queryClient = useQueryClient()
  const [, navigate] = useLocation()

  const exportBoard = useCallback(async (boardId: string) => {
    try {
      const data = await api.exportBoard(boardId)
      download(`${slugify(data.board.name)}.ultrakanban.json`, JSON.stringify(data, null, 2))
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }, [])

  const importBoard = useCallback(async () => {
    const [file] = await pickFiles('application/json,.json')
    if (!file) return
    try {
      const board = await api.importBoard(JSON.parse(await file.text()))
      await queryClient.invalidateQueries({ queryKey: queryKeys.boards })
      toast.success(`Imported “${board.name}”`)
      navigate(`/b/${board.id}`)
    } catch (error) {
      toast.error(error instanceof SyntaxError ? 'That file is not valid JSON' : errorMessage(error))
    }
  }, [queryClient, navigate])

  return { exportBoard, importBoard }
}
