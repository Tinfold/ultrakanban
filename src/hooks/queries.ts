import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

export const queryKeys = {
  boards: ['boards'] as const,
  board: (boardId: string) => ['board', boardId] as const,
  activity: (ticketId: string) => ['activity', ticketId] as const,
  allActivity: ['activity'] as const,
  attachments: (ticketId: string) => ['attachments', ticketId] as const,
  allAttachments: ['attachments'] as const,
  github: ['github'] as const,
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
