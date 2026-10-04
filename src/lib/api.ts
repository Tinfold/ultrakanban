import type {
  Activity,
  AgentSuggestion,
  AppUpdate,
  ApiErrorBody,
  Attachment,
  BoardDetail,
  BoardSummary,
  Column,
  Epic,
  MergeMethod,
  MergePlan,
  MergeRun,
  Overview,
  OverviewRange,
  Tag,
  Ticket,
} from '@shared/domain'
import type {
  BoardExport,
  BulkTicketsInput,
  CreateBoardInput,
  CreateColumnInput,
  CreateEpicInput,
  CreateGitHubRepoInput,
  CreateTagInput,
  CreateTicketInput,
  MoveTicketInput,
  UpdateBoardInput,
  UpdateColumnInput,
  UpdateEpicInput,
  UpdateTagInput,
  UpdateTicketInput,
} from '@shared/schemas'
import { readActor } from './actor'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Sends JSON, or `FormData` as multipart (the browser sets its content type). */
async function request<T>(method: string, path: string, body?: unknown, keepalive?: boolean): Promise<T> {
  const json = body !== undefined && !(body instanceof FormData)
  const response = await fetch(`/api${path}`, {
    method,
    keepalive,
    headers: { 'X-Actor': readActor(), ...(json && { 'Content-Type': 'application/json' }) },
    body: json ? JSON.stringify(body) : (body as FormData | undefined),
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as ApiErrorBody | null
    throw new ApiError(response.status, data?.error.code ?? 'http_error', data?.error.message ?? response.statusText)
  }
  return response.status === 204 ? (undefined as T) : response.json()
}

const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => !!entry[1]))
  return search.size ? `?${search}` : ''
}

export const api = {
  listBoards: () => request<BoardSummary[]>('GET', '/boards'),
  // Archived tickets too: the board hides them unless asked, and search finds them.
  getBoard: (boardId: string) => request<BoardDetail>('GET', `/boards/${boardId}?archived=true`),
  createBoard: (input: CreateBoardInput) => request<BoardSummary>('POST', '/boards', input),
  updateBoard: (boardId: string, input: UpdateBoardInput) =>
    request<BoardSummary>('PATCH', `/boards/${boardId}`, input),
  deleteBoard: (boardId: string) => request<void>('DELETE', `/boards/${boardId}`),
  exportBoard: (boardId: string) => request<BoardExport>('GET', `/boards/${boardId}/export`),
  createGitHubRepo: (boardId: string, input: CreateGitHubRepoInput) =>
    request<BoardSummary>('POST', `/boards/${boardId}/github-repo`, input),
  importBoard: (data: unknown) => request<BoardSummary>('POST', '/boards/import', data),

  createColumn: (boardId: string, input: CreateColumnInput) =>
    request<Column>('POST', `/boards/${boardId}/columns`, input),
  updateColumn: (columnId: string, input: UpdateColumnInput) => request<Column>('PATCH', `/columns/${columnId}`, input),
  moveColumn: (columnId: string, position: number) =>
    request<Column>('POST', `/columns/${columnId}/move`, { position }),
  deleteColumn: (columnId: string, moveTicketsTo?: string) =>
    request<void>('DELETE', `/columns/${columnId}${query({ moveTicketsTo })}`),
  idleTickets: (columnId: string) => request<Ticket[]>('GET', `/columns/${columnId}/idle-tickets`),
  releaseIdleTickets: (columnId: string, moveTo: string) =>
    request<Ticket[]>('POST', `/columns/${columnId}/release-idle`, { moveTo }),

  createTag: (boardId: string, input: CreateTagInput) => request<Tag>('POST', `/boards/${boardId}/tags`, input),
  updateTag: (tagId: string, input: UpdateTagInput) => request<Tag>('PATCH', `/tags/${tagId}`, input),
  deleteTag: (tagId: string) => request<void>('DELETE', `/tags/${tagId}`),

  createEpic: (boardId: string, input: CreateEpicInput) => request<Epic>('POST', `/boards/${boardId}/epics`, input),
  updateEpic: (epicId: string, input: UpdateEpicInput) => request<Epic>('PATCH', `/epics/${epicId}`, input),
  deleteEpic: (epicId: string) => request<void>('DELETE', `/epics/${epicId}`),

  /** A model and effort for a ticket about to be created, from how similar tickets went. */
  agentSuggestion: (boardId: string, input: { title: string; tags: string[]; steps: number }) => {
    const search = new URLSearchParams({ title: input.title, steps: String(input.steps) })
    for (const tag of input.tags) search.append('tag', tag)
    return request<AgentSuggestion>('GET', `/boards/${boardId}/agent-suggestion?${search}`)
  },
  createTicket: (boardId: string, input: CreateTicketInput) =>
    request<Ticket>('POST', `/boards/${boardId}/tickets`, input),
  updateTicket: (ticketId: string, input: UpdateTicketInput) => request<Ticket>('PATCH', `/tickets/${ticketId}`, input),
  moveTicket: (ticketId: string, input: MoveTicketInput) => request<Ticket>('POST', `/tickets/${ticketId}/move`, input),
  /** Kept alive so a delete sent as the page closes still arrives. */
  deleteTicket: (ticketId: string) => request<void>('DELETE', `/tickets/${ticketId}`, undefined, true),
  /** Kept alive, like `deleteTicket`, for bulk deletes sent as the page closes. */
  bulkTickets: (boardId: string, input: BulkTicketsInput) =>
    request<{ tickets: Ticket[] }>('POST', `/boards/${boardId}/tickets/bulk`, input, true),
  listActivity: (ticketId: string) => request<Activity[]>('GET', `/tickets/${ticketId}/activity`),
  approvePlan: (ticketId: string) => request<Ticket>('POST', `/tickets/${ticketId}/approve`),
  syncPullRequest: (ticketId: string) => request<Ticket>('POST', `/tickets/${ticketId}/pull-request/sync`),
  mergeTicket: (ticketId: string, method: MergeMethod) =>
    request<Ticket>('POST', `/tickets/${ticketId}/merge`, { method }),
  fixConflicts: (boardId: string) => request<{ tickets: Ticket[] }>('POST', `/boards/${boardId}/fix-conflicts`),
  githubStatus: () => request<{ auth: 'env' | 'gh' | null }>('GET', '/github'),
  listAttachments: (ticketId: string) => request<Attachment[]>('GET', `/tickets/${ticketId}/attachments`),
  uploadAttachment: (ticketId: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<Attachment>('POST', `/tickets/${ticketId}/attachments`, form)
  },
  deleteAttachment: (attachmentId: string) => request<void>('DELETE', `/attachments/${attachmentId}`),
  addComment: (ticketId: string, body: string, pullRequest = false) =>
    request<Activity>('POST', `/tickets/${ticketId}/comments`, { body, pullRequest }),
  mergePlan: (boardId: string) => request<MergePlan>('GET', `/boards/${boardId}/merge-plan`),
  mergeRun: (boardId: string) => request<MergeRun | null>('GET', `/boards/${boardId}/merge-run`),
  startMergeRun: (boardId: string, method: MergeMethod) =>
    request<MergeRun>('POST', `/boards/${boardId}/merge-run`, { method }),
  overview: (days: OverviewRange) => request<Overview>('GET', `/overview${query({ days: String(days) })}`),
  hideAgents: (names: string[]) => request<void>('POST', '/overview/hidden-agents', { names }),
  showHiddenAgents: () => request<void>('DELETE', '/overview/hidden-agents'),
  appUpdate: () => request<AppUpdate>('GET', '/system/update'),
  requestAppUpdate: () => request<AppUpdate>('POST', '/system/update'),
  cancelAppUpdate: () => request<AppUpdate>('DELETE', '/system/update'),
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong')
