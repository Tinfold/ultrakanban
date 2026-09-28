import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { toast } from 'sonner'
import type { BoardDetail, MergeMethod } from '@shared/domain'
import type { CreateColumnInput, CreateTagInput, CreateTicketInput } from '@shared/schemas'
import { api, errorMessage } from '@/lib/api'
import * as updates from '@/lib/board-updates'
import { queryKeys } from './queries'

export type BoardActions = ReturnType<typeof useBoardActions>

/**
 * All mutations for one board. Each applies an optimistic update to the cached board (when possible),
 * rolls it back and shows a toast on failure, and refetches afterwards.
 */
export function useBoardActions(boardId: string) {
  const queryClient = useQueryClient()

  return useMemo(() => {
    const boardKey = queryKeys.board(boardId)

    const refreshTicketFeeds = (ticketId: string) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.attachments(ticketId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(ticketId) }),
      ])

    const update = (fn: (detail: BoardDetail) => BoardDetail) =>
      queryClient.setQueryData<BoardDetail>(boardKey, (detail) => detail && fn(detail))

    /**
     * @param optimistic applied to the cache before the request is sent
     * @param reconcile applied to the cache with the server response (e.g. to add a created entity right away)
     */
    async function run<R>(
      request: () => Promise<R>,
      optimistic?: (detail: BoardDetail) => BoardDetail,
      reconcile?: (detail: BoardDetail, result: R) => BoardDetail,
    ) {
      const previous = queryClient.getQueryData<BoardDetail>(boardKey)
      if (optimistic && previous) {
        void queryClient.cancelQueries({ queryKey: boardKey })
        queryClient.setQueryData(boardKey, optimistic(previous))
      }
      try {
        const result = await request()
        if (reconcile) update((detail) => reconcile(detail, result))
        return result
      } catch (error) {
        if (optimistic && previous) queryClient.setQueryData(boardKey, previous)
        toast.error(errorMessage(error))
        return undefined
      } finally {
        void queryClient.invalidateQueries({ queryKey: boardKey })
        void queryClient.invalidateQueries({ queryKey: queryKeys.boards })
      }
    }

    return {
      updateBoard: (patch: updates.BoardPatch) => {
        const { reviewColumnId, doneColumnId, ...fields } = patch
        return run(
          () => api.updateBoard(boardId, { ...fields, reviewColumn: reviewColumnId, doneColumn: doneColumnId }),
          (d) => updates.patchBoard(d, patch),
        )
      },

      createColumn: (input: CreateColumnInput) =>
        run(() => api.createColumn(boardId, input), undefined, updates.addColumn),
      updateColumn: (columnId: string, patch: updates.ColumnPatch) =>
        run(
          () => api.updateColumn(columnId, patch),
          (d) => updates.patchColumn(d, columnId, patch),
        ),
      moveColumn: (columnId: string, position: number) =>
        run(
          () => api.moveColumn(columnId, position),
          (d) => updates.moveColumn(d, columnId, position),
        ),
      deleteColumn: (columnId: string, moveTicketsTo?: string) =>
        run(
          () => api.deleteColumn(columnId, moveTicketsTo),
          (d) => updates.removeColumn(d, columnId, moveTicketsTo),
        ),
      /** Unassigns the column's idle tickets and moves them to another column. */
      releaseIdleTickets: async (columnId: string, moveTo: string) => {
        const released = await run(() => api.releaseIdleTickets(columnId, moveTo))
        await queryClient.invalidateQueries({ queryKey: queryKeys.idleTickets(columnId) })
        if (released) toast.success(`Moved ${released.length} ticket${released.length === 1 ? '' : 's'}`)
        return released
      },
      /** Asks the agents to fix the merge conflicts of the review column's pull requests, and wakes them up. */
      fixConflicts: async () => {
        const result = await run(() => api.fixConflicts(boardId))
        if (result) {
          const count = result.tickets.length
          toast.success(`Asked the agent to fix the conflicts of ${count} ticket${count === 1 ? '' : 's'}`)
        }
        return result
      },

      createTag: (input: CreateTagInput) => run(() => api.createTag(boardId, input), undefined, updates.addTag),
      updateTag: (tagId: string, patch: updates.TagPatch) =>
        run(
          () => api.updateTag(tagId, patch),
          (d) => updates.patchTag(d, tagId, patch),
        ),
      deleteTag: (tagId: string) =>
        run(
          () => api.deleteTag(tagId),
          (d) => updates.removeTag(d, tagId),
        ),

      createTicket: (input: CreateTicketInput) =>
        run(() => api.createTicket(boardId, input), undefined, updates.addTicket),
      updateTicket: (ticketId: string, patch: updates.TicketPatch) => {
        const { tagIds, ...fields } = patch
        return run(
          () => api.updateTicket(ticketId, { ...fields, tags: tagIds }),
          (d) => updates.patchTicket(d, ticketId, patch),
        )
      },
      /** `force` skips the done column's merged pull request requirement. */
      moveTicket: (ticketId: string, columnId: string, position?: number, force?: boolean) =>
        run(
          () => api.moveTicket(ticketId, { column: columnId, position, force }),
          (d) => updates.moveTicket(d, ticketId, columnId, position),
        ),
      linkPullRequest: (ticketId: string, url: string | null) =>
        run(
          () => api.updateTicket(ticketId, { pullRequest: url }),
          (d) => updates.linkPullRequest(d, ticketId, url),
          updates.addTicket,
        ),
      /** Approves the plan the ticket's agent waits on, so it goes on to work the ticket. */
      approvePlan: async (ticketId: string) => {
        const ticket = await run(() => api.approvePlan(ticketId), undefined, updates.addTicket)
        await queryClient.invalidateQueries({ queryKey: queryKeys.activity(ticketId) })
        if (ticket) toast.success('Plan approved; the agent will carry on')
        return ticket
      },
      syncPullRequest: (ticketId: string) => run(() => api.syncPullRequest(ticketId), undefined, updates.addTicket),
      /** Merges the ticket's pull request, which moves the ticket to the done column. */
      mergeTicket: async (ticketId: string, method: MergeMethod) => {
        const ticket = await run(() => api.mergeTicket(ticketId, method), undefined, updates.addTicket)
        if (ticket?.pullRequest) toast.success(`Merged ${ticket.pullRequest.repo}#${ticket.pullRequest.number}`)
        return ticket
      },
      deleteTicket: (ticketId: string) =>
        run(
          () => api.deleteTicket(ticketId),
          (d) => updates.removeTicket(d, ticketId),
        ),
      addComment: async (ticketId: string, body: string) => {
        const comment = await run(() => api.addComment(ticketId, body))
        await queryClient.invalidateQueries({ queryKey: queryKeys.activity(ticketId) })
        return comment
      },
      /** Uploads files one by one; failures are reported per file without stopping the rest. */
      uploadAttachments: async (ticketId: string, files: File[]) => {
        for (const file of files) await run(() => api.uploadAttachment(ticketId, file))
        await refreshTicketFeeds(ticketId)
      },
      deleteAttachment: async (ticketId: string, attachmentId: string) => {
        await run(() => api.deleteAttachment(attachmentId))
        await refreshTicketFeeds(ticketId)
      },
    }
  }, [queryClient, boardId])
}
