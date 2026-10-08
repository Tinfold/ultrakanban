import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { OverviewRange } from '@shared/domain'
import { api } from '@/lib/api'
import { withoutPendingDeletes } from '@/lib/board-updates'

export const queryKeys = {
  boards: ['boards'] as const,
  board: (boardId: string) => ['board', boardId] as const,
  activity: (ticketId: string) => ['activity', ticketId] as const,
  allActivity: ['activity'] as const,
  attachments: (ticketId: string) => ['attachments', ticketId] as const,
  allAttachments: ['attachments'] as const,
  github: ['github'] as const,
  idleTickets: (columnId: string) => ['idle-tickets', columnId] as const,
  mergePlan: (boardId: string) => ['merge-plan', boardId] as const,
  mergeRun: (boardId: string) => ['merge-run', boardId] as const,
  overview: (days: OverviewRange) => ['overview', days] as const,
  allOverviews: ['overview'] as const,
  appUpdate: ['app-update'] as const,
  claudeUsage: ['claude-usage'] as const,
  setup: ['setup'] as const,
}

export const useBoards = () => useQuery({ queryKey: queryKeys.boards, queryFn: api.listBoards })

/** Tickets waiting to be deleted stay hidden, even when the board is refetched meanwhile. */
export const useBoard = (boardId: string) =>
  useQuery({
    queryKey: queryKeys.board(boardId),
    queryFn: () => api.getBoard(boardId),
    select: withoutPendingDeletes,
    retry: false,
  })

export const useTicketActivity = (ticketId: string) =>
  useQuery({ queryKey: queryKeys.activity(ticketId), queryFn: () => api.listActivity(ticketId) })

export const useGitHubStatus = () =>
  useQuery({ queryKey: queryKeys.github, queryFn: api.githubStatus, staleTime: 5 * 60_000 })

export const useTicketAttachments = (ticketId: string) =>
  useQuery({ queryKey: queryKeys.attachments(ticketId), queryFn: () => api.listAttachments(ticketId) })

/** Keeps showing the previous range while another one loads. */
export const useOverview = (days: OverviewRange) =>
  useQuery({ queryKey: queryKeys.overview(days), queryFn: () => api.overview(days), placeholderData: keepPreviousData })

/** A column's tickets no agent is working on. Checked every minute, since tickets become idle as time passes. */
export const useIdleTickets = (columnId: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.idleTickets(columnId),
    queryFn: () => api.idleTickets(columnId),
    enabled,
    refetchInterval: 60_000,
  })

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

/** Checked every few seconds while an update is on its way, so the header follows it through the restart. */
export const useAppUpdate = () =>
  useQuery({
    queryKey: queryKeys.appUpdate,
    queryFn: api.appUpdate,
    refetchInterval: (query) => {
      const state = query.state.data?.state
      return state === 'requested' || state === 'running' ? 3000 : 60_000
    },
  })

/** The supervisor reports Claude usage every few minutes. */
export const useClaudeUsage = () =>
  useQuery({ queryKey: queryKeys.claudeUsage, queryFn: api.claudeUsage, refetchInterval: 60_000 })

/** Followed closely while a login runs, so the page shows GitHub's code or Claude's link as soon as they are there. */
export const useSetup = () =>
  useQuery({
    queryKey: queryKeys.setup,
    queryFn: api.setup,
    refetchInterval: (query) => {
      const state = query.state.data?.agents.login?.state
      return state === 'requested' || state === 'waiting' || state === 'checking' ? 2000 : 30_000
    },
  })
