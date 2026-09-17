import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { BoardChangeEvent } from '@shared/domain'
import { queryKeys } from './queries'

/** Keeps cached data fresh when anyone (UI in another tab, agents) changes a board. */
export function useLiveUpdates() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const source = new EventSource('/api/events')
    source.addEventListener('change', (message) => {
      const { boardId } = JSON.parse(message.data) as BoardChangeEvent
      void queryClient.invalidateQueries({ queryKey: queryKeys.boards })
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.allActivity })
      void queryClient.invalidateQueries({ queryKey: queryKeys.allAttachments })
    })
    let connected = false
    source.addEventListener('open', () => {
      // After a reconnect, changes may have been missed while disconnected.
      if (connected) void queryClient.invalidateQueries()
      connected = true
    })
    return () => source.close()
  }, [queryClient])
}
