import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { OverviewRange } from '@shared/domain'
import { api } from '@/lib/api'

export const queryKeys = {
  boards: ['boards'] as const,
  board: (boardId: string) => ['board', boardId] as const,
  activity: (ticketId: string) => ['activity', ticketId] as const,
  allActivity: ['activity'] as const,
  attachments: (ticketId: string) => ['attachments', ticketId] as const,
  allAttachments: ['attachments'] as const,
  github: ['github'] as const,
  mergePlan: (boardId: string) => ['merge-plan', boardId] as const,
  mergeRun: (boardId: string) => ['merge-run', boardId] as const,
  overview: (days: OverviewRange) => ['overview', days] as const,
  allOverviews: ['overview'] as const,
}

export const useBoards = () => useQuery({ queryKey: queryKeys.boards, queryFn: api.listBoards })

export const useBoard = (boardId: string) =>
  useQuery({ queryKey: queryKeys.board(boardId), queryFn: () => api.getBoard(boardId), retry: false })

export const useTicketActivity = (ticketId: string) =>
  useQuery({ queryKey: queryKeys.activity(ticketId), queryFn: () => api.listActivity(ticketId) })

export const useGitHubStatus = () =>
  useQuery({ queryKey: queryKeys.github, queryFn: api.githubStatus, staleTime: 5 * 60_000 })

export const useTicketAttachments = (ticketId: string) =>
  useQuery({ queryKey: queryKeys.attachments(ticketId), queryFn: () => api.listAttachments(ticketId) })

/** Keeps showing the previous range while another one loads. */
export const useOverview = (days: OverviewRange) =>
  useQuery({ queryKey: queryKeys.overview(days), queryFn: () => api.overview(days), placeholderData: keepPreviousData })

/** Asks GitHub about every pull request in review, so it is only loaded while needed. */
export const useMergePlan = (boardId: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.mergePlan(boardId),
    queryFn: () => api.mergePlan(boardId),
    enabled,
    // Dropped once the dialog closes, so it never shows pull requests merged since.
    gcTime: 0,
    retry: false,
  })

/** The board's latest "merge all" run, followed closely while it runs. */
export const useMergeRun = (boardId: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.mergeRun(boardId),
    queryFn: () => api.mergeRun(boardId),
    enabled,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1000 : false),
  })
