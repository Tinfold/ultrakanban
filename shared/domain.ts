export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const
export type Priority = (typeof PRIORITIES)[number]

export const COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink'] as const
export type Color = (typeof COLORS)[number]

/** Deterministic, non-gray palette color for a name (tags, avatars). */
export function colorForName(name: string): Color {
  const hash = [...name.toLowerCase()].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7)
  return COLORS[1 + (hash % (COLORS.length - 1))]
}

export const PULL_REQUEST_STATES = ['unknown', 'open', 'draft', 'merged', 'closed'] as const
/** `unknown` until GitHub has been checked (or when it can't be reached). */
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number]

export interface PullRequest {
  url: string
  /** `owner/name` */
  repo: string
  number: number
  state: PullRequestState
  title: string | null
  checkedAt: string | null
}

const PULL_REQUEST_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/

/** Parses a GitHub pull request URL (also accepts sub-pages like `/files`). */
export function parsePullRequestUrl(url: string) {
  const match = PULL_REQUEST_URL.exec(url.trim())
  if (!match) return null
  const [, owner, name, number] = match
  return {
    url: `https://github.com/${owner}/${name}/pull/${number}`,
    owner,
    name,
    repo: `${owner}/${name}`,
    number: Number(number),
  }
}

/** Screenshots and screen recordings. SVG is excluded because it can carry scripts. */
export const ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number]
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface Attachment {
  id: string
  ticketId: string
  filename: string
  contentType: AttachmentType
  size: number
  actor: string
  createdAt: string
  /** Path on the server, e.g. `/api/attachments/abc`; usable in markdown as `![screenshot](/api/attachments/abc)`. */
  url: string
}

export interface BoardSummary {
  id: string
  name: string
  description: string
  /** Column agents submit tickets to with a pull request (`POST /tickets/:id/review`). */
  reviewColumnId: string | null
  /** Column that only accepts tickets whose pull request is merged; merged tickets move here automatically. */
  doneColumnId: string | null
  /** GitHub repository (`owner/name`) the board's tickets are about. */
  githubRepo: string | null
  /** Whether the host's agent supervisor runs an agent loop for this board (see scripts/agent-supervisor.sh). */
  agentEnabled: boolean
  /** Name the agent claims tickets under; `claude` when not set. */
  agentName: string | null
  ticketCount: number
  createdAt: string
  updatedAt: string
}

export interface Column {
  id: string
  boardId: string
  name: string
  color: Color
  wipLimit: number | null
  position: number
}

export interface Tag {
  id: string
  boardId: string
  name: string
  color: Color
}

export interface Ticket {
  id: string
  boardId: string
  /** Board-scoped, human friendly number (displayed as #12). */
  number: number
  columnId: string
  title: string
  /** Markdown. */
  description: string
  priority: Priority
  assignee: string | null
  /** ISO date (YYYY-MM-DD). */
  dueDate: string | null
  tagIds: string[]
  pullRequest: PullRequest | null
  position: number
  /** Incremented on every change; pass as `ifVersion` for optimistic concurrency. */
  version: number
  commentCount: number
  attachmentCount: number
  createdAt: string
  updatedAt: string
}

export interface BoardDetail {
  board: BoardSummary
  columns: Column[]
  tags: Tag[]
  tickets: Ticket[]
}

export type Activity =
  | ActivityBase<'created', { column: string }>
  | ActivityBase<'updated', { fields: string[] }>
  | ActivityBase<'moved', { from: string; to: string }>
  | ActivityBase<'claimed', { assignee: string }>
  | ActivityBase<'released', { assignee: string }>
  | ActivityBase<'comment', { body: string }>
  | ActivityBase<'attachment', { attachmentId: string; filename: string; contentType: AttachmentType }>
  | ActivityBase<'pull_request', { url: string; event: 'linked' | 'unlinked' | Exclude<PullRequestState, 'unknown'> }>

export type ActivityType = Activity['type']

interface ActivityBase<T extends string, D> {
  id: number
  ticketId: string
  actor: string
  type: T
  data: D
  createdAt: string
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}

/** Server-sent event emitted on `/api/events` whenever a board changes. */
export interface BoardChangeEvent {
  boardId: string
}
