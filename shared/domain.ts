export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const
export type Priority = (typeof PRIORITIES)[number]

export const COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink'] as const
export type Color = (typeof COLORS)[number]

/** Deterministic, non-gray palette color for a name (tags, avatars). */
export function colorForName(name: string): Color {
  const hash = [...name.toLowerCase()].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7)
  return COLORS[1 + (hash % (COLORS.length - 1))]
}

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]

/**
 * Model aliases offered for a ticket; boards and tickets can also name a model in full, e.g. claude-opus-5-5, or one
 * that an Anthropic-compatible endpoint serves the agent instead of Claude, e.g. qwen3-coder:30b (see docs/agents.md).
 */
export const AGENT_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const

/** Whether a model is one of Claude's: an alias (`AGENT_MODELS`) or a full name such as claude-opus-5-5. */
export const isClaudeModel = (model: string) =>
  (AGENT_MODELS as readonly string[]).includes(model) || /^claude-/i.test(model)

/** What a board's agent runs as when the board doesn't say (see scripts/agent-board.sh). */
export const AGENT_DEFAULTS = { name: 'claude', model: 'opus', effort: 'medium', concurrency: 1 } as const
/** Most runs a board's agent can work at once; each one needs its own git worktree and counts against Claude usage. */
export const AGENT_MAX_CONCURRENCY = 8

/**
 * A ticket counts as idle (no agent is working on it) when no agent has sent a heartbeat for it
 * (`POST /tickets/:id/heartbeat`) and nothing has happened on it for this long.
 */
export const AGENT_IDLE_MINUTES = 10

/**
 * Name of the tag that marks a ticket as a question (case-insensitive): it is answered in a comment rather than with a
 * pull request, so it can go to review and then to the done column without one.
 */
export const QUESTION_TAG = 'question'

/**
 * Name of the column (case-insensitive) where tickets nobody will work on go, e.g. when their pull request was closed
 * without merging. Sub-tickets there don't count towards their parent's progress.
 */
export const CANCELLED_COLUMN = 'cancelled'

export interface TicketTemplate {
  id: string
  name: string
  /** Starting description, including a `- [ ]` checklist where useful. */
  description: string
  tags: string[]
  agentEffort: AgentEffort | null
  agentModel: string | null
}

/** Starting points offered in the new-ticket form: a description, tags, and a model/effort already picked. */
export const TICKET_TEMPLATES: readonly TicketTemplate[] = [
  {
    id: 'bug',
    name: 'Bug',
    description:
      '## Steps to reproduce\n\n## Expected\n\n## Actual\n\n- [ ] Find the cause\n- [ ] Fix it\n- [ ] Add a test that would have caught it',
    tags: ['bug'],
    agentEffort: 'medium',
    agentModel: 'opus',
  },
  {
    id: 'feature',
    name: 'Feature',
    description: '## What\n\n## Why\n\n- [ ] Implement it\n- [ ] Tests',
    tags: ['feature'],
    agentEffort: 'medium',
    agentModel: 'opus',
  },
  {
    id: 'question',
    name: 'Question',
    description: '',
    tags: [QUESTION_TAG],
    agentEffort: 'low',
    agentModel: 'sonnet',
  },
] as const

/**
 * A run on a ticket looks stalled when its agent hasn't sent a heartbeat for this long. scripts/agent-loop.sh sends
 * one every 30 seconds by default (TICKET_CHECK_SECONDS).
 */
export const AGENT_RUN_STALLED_MINUTES = 3

/** Sizes an agent estimates a ticket at when it posts its plan (`POST /tickets/:id/plan`), smallest first. */
export const TICKET_SIZES = ['S', 'M', 'L'] as const
export type TicketSize = (typeof TICKET_SIZES)[number]

/**
 * Whether a ticket estimated at `size` waits for a person's approval on a board that holds tickets of `approvalSize`
 * and larger (see `BoardSummary.approvalSize`).
 */
export const needsApproval = (size: TicketSize, approvalSize: TicketSize | null) =>
  approvalSize !== null && TICKET_SIZES.indexOf(size) >= TICKET_SIZES.indexOf(approvalSize)

/**
 * Where a ticket is with approval of its agent's plan: `pending` while the agent waits for a person to approve it
 * (`POST /tickets/:id/approve`) before it works the ticket, `approved` once someone has.
 */
export type Approval = 'pending' | 'approved'

/**
 * Name a board's agent claims tickets under: `<agent>/<model>/<effort>`, e.g. `claude/opus/high`. The agent name
 * itself belongs to the board's controller (scripts/agent-loop.sh), which starts one of these workers per run.
 */
export function agentWorkerName(board: Pick<BoardSummary, 'agentName' | 'agentModel' | 'agentEffort'>) {
  const { name, model, effort } = AGENT_DEFAULTS
  return `${board.agentName ?? name}/${board.agentModel ?? model}/${board.agentEffort ?? effort}`
}

/**
 * The parts of an `<agent>/<model>/<effort>` name (see `agentWorkerName`): the agent first, the effort last and the
 * model everything in between, so model names with slashes work too (`opencode/openrouter/qwen/qwen3-coder/high`).
 * The effort is whatever the agent calls it: agents other than Claude Code have their own levels (`minimal`) or
 * `default` for models without any. An `<agent>/<model>` name has no effort. Null for other names, e.g. a person's.
 */
export function parseWorkerName(name: string): { agent: string; model: string; effort: string | null } | null {
  const parts = name.split('/')
  if (parts.length < 2 || parts.some((part) => !part)) return null
  if (parts.length === 2) return { agent: parts[0], model: parts[1], effort: null }
  return { agent: parts[0], model: parts.slice(1, -1).join('/'), effort: parts[parts.length - 1] }
}

/**
 * The model a run under an `<agent>/<model>/<effort>` name (see `parseWorkerName`) runs, e.g. `opus` for
 * `claude/opus/high` or `gpt-5-codex` for `codex/gpt-5-codex/minimal`; null for other names.
 */
export function workerModel(agent: string) {
  return parseWorkerName(agent)?.model ?? null
}

/**
 * The model and effort a run under an `<agent>/<model>/<effort>` name (see `parseWorkerName`) works at, e.g.
 * `{ model: 'opus', effort: 'high' }` for `claude/opus/high`; null for other names and for efforts the board's agent
 * doesn't have (`AGENT_EFFORTS`).
 */
export function workerSetting(agent: string): { model: string; effort: AgentEffort } | null {
  const worker = parseWorkerName(agent)
  const isEffort = (AGENT_EFFORTS as readonly string[]).includes(worker?.effort ?? '')
  return worker && isEffort ? { model: worker.model, effort: worker.effort as AgentEffort } : null
}

export const PULL_REQUEST_STATES = ['unknown', 'open', 'draft', 'merged', 'closed'] as const
/** `unknown` until GitHub has been checked (or when it can't be reached). */
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number]

export const CHECK_STATUSES = ['pending', 'passing', 'failing'] as const
/** GitHub's combined status for the pull request's head commit. */
export type CheckStatus = (typeof CHECK_STATUSES)[number]

export interface PullRequest {
  url: string
  /** `owner/name` */
  repo: string
  number: number
  state: PullRequestState
  title: string | null
  /** Whether GitHub last found that it can't merge cleanly into its base branch (only open and draft ones). */
  conflicts: boolean
  /** Combined status of its checks; `null` when it has none, or isn't open or draft. */
  checks: CheckStatus | null
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

export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const
/** How GitHub merges a pull request: a merge commit, one squashed commit, or its commits rebased onto the base. */
export type MergeMethod = (typeof MERGE_METHODS)[number]

/** A pull request in the review column, in the order "merge all" merges them (`GET /boards/:id/merge-plan`). */
export interface MergePlanItem {
  ticketId: string
  ticketNumber: number
  ticketTitle: string
  url: string
  /** `owner/name` */
  repo: string
  number: number
  title: string | null
  /** Branch it merges into. */
  base: string | null
  /** Its own branch. */
  head: string | null
  /** Commit it merges; a run skips it if new commits arrive meanwhile. */
  headSha: string | null
  /** Tickets whose pull requests this one builds on (stacked on their branch or containing their commits). */
  after: string[]
  /** Other tickets in the plan whose pull requests change some of the same files. */
  overlaps: string[]
  /** Why it may not merge, e.g. required reviews or checks, though merging is still attempted. */
  warning: string | null
  /** Why it won't be merged at all (draft, conflicts, no longer open, unreadable). */
  skip: string | null
}

export interface MergePlan {
  items: MergePlanItem[]
  /** Merge methods every repository in the plan allows. */
  methods: MergeMethod[]
}

export type MergeStepStatus = 'pending' | 'merging' | 'merged' | 'skipped' | 'failed'

export interface MergeRunStep extends MergePlanItem {
  status: MergeStepStatus
  /** Why it was skipped or failed. */
  message: string | null
}

/** A "merge all" run: merges a board's reviewed pull requests one at a time, in plan order. */
export interface MergeRun {
  id: string
  boardId: string
  actor: string
  method: MergeMethod
  status: 'running' | 'finished'
  startedAt: string
  finishedAt: string | null
  steps: MergeRunStep[]
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
  /** Name of the board's agent (its controller); `claude` when not set. Its workers are named by `agentWorkerName`. */
  agentName: string | null
  /**
   * Model the agent runs Claude Code with: a Claude alias or full model name, or another model that an
   * Anthropic-compatible endpoint serves (see docs/agents.md); `opus` when not set.
   */
  agentModel: string | null
  /** Effort level the agent runs at; `medium` when not set. */
  agentEffort: AgentEffort | null
  /** How many runs the agent works at once, each on its own ticket in its own git worktree; 1 when not set. */
  agentConcurrency: number | null
  /** Whether the agent also takes tickets from the Backlog column once the Todo column has none left. */
  agentBacklog: boolean
  /**
   * Whether the agent's runs load every skill (the account's, plugins' and the repository's). Otherwise they only get
   * the ultrakanban skill, unless the repository has skills of its own.
   */
  agentAllSkills: boolean
  /**
   * Whether the agent runs Claude in a Docker container (see scripts/agent-loop/Dockerfile) instead of directly on the
   * machine. A ticket can override it with its own `agentDocker`.
   */
  agentDocker: boolean
  /**
   * Whether the server merges the review column's pull requests by itself once they are ready: open, not a draft,
   * no conflicts, every check passed and every checklist item of the ticket checked.
   */
  autoMerge: boolean
  /**
   * Days a ticket stays in the done column before it is archived: left out of the board (`GET /boards/:id`) unless
   * asked for, but still found by the ticket list and search. Never archived when not set.
   */
  archiveDoneDays: number | null
  /**
   * Smallest size estimate (see `TICKET_SIZES`) at which the agent waits for a person to approve its plan before it
   * works a ticket, e.g. `L` holds only large tickets and `S` every one. Never waits when not set.
   */
  approvalSize: TicketSize | null
  /**
   * Where to send a message when a ticket needs a person (an agent asks a question, CI needs someone, a pull request
   * is ready to merge): an ntfy topic, a Discord webhook or any other webhook URL. Nothing is sent when not set.
   */
  notifyUrl: string | null
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

/**
 * A larger piece of work that groups tickets of a board (`epicId` on them), sub-tickets included. Agents never claim
 * it: it is done by itself once all its tickets are.
 */
export interface Epic {
  id: string
  boardId: string
  title: string
  /** Markdown. */
  description: string
  color: Color
  /**
   * Its tickets that are finished (in the done column or with a merged pull request) out of all of them, leaving out
   * cancelled ones.
   */
  progress: { done: number; total: number }
  /** Whether it has tickets and they are all finished. */
  done: boolean
  createdAt: string
  updatedAt: string
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
  /** Effort level the board's agent works this ticket at; the board's `agentEffort` when not set. */
  agentEffort: AgentEffort | null
  /** Model the board's agent works this ticket with; the board's `agentModel` when not set. */
  agentModel: string | null
  /** Whether the board's agent works this ticket in a Docker container; the board's `agentDocker` when not set. */
  agentDocker: boolean | null
  tagIds: string[]
  pullRequest: PullRequest | null
  position: number
  /** Incremented on every change; pass as `ifVersion` for optimistic concurrency. */
  version: number
  commentCount: number
  attachmentCount: number
  /** Tokens agents' runs used on it, added up over all of them. */
  usage: TicketUsage
  /** The agent run working the ticket right now, if any (see `AgentRun`). */
  run: AgentRun | null
  /**
   * When its agent started waiting on a person: set while the newest comment is from its assignee, or its assignee's
   * plan is newer than every comment and waits for approval, and it's worked (not in review or done).
   */
  waitingSince: string | null
  /** The size its agent estimated it at in its latest plan (`POST /tickets/:id/plan`); null before it posted one. */
  estimate: TicketSize | null
  /** Whether its agent's plan waits for approval or has it (see `Approval`); null when it doesn't need any. */
  approval: Approval | null
  /** When the ticket entered its current column. */
  movedAt: string
  /** Whether it has been in the board's done column for longer than the board's `archiveDoneDays`. */
  archived: boolean
  /** The ticket this one is a sub-ticket of; null when it isn't one. */
  parentId: string | null
  /**
   * Its sub-tickets that are finished (in the done column or with a merged pull request) out of all of them, leaving
   * out cancelled ones. Null when it has none. It waits for them: claim-next skips it until they are all finished.
   */
  subtickets: { done: number; total: number } | null
  /** The epic it belongs to; null when it is in none. */
  epicId: string | null
  createdAt: string
  updatedAt: string
}

/** A ticket's token usage added up over all the agent runs on it. */
export interface TicketUsage {
  runs: number
  /** Input, output and cache tokens together (see `totalTokens`). */
  tokens: number
  /** Estimated cost in US dollars of the runs that reported one; `null` when none did. */
  costUsd: number | null
}

/** A finished or abandoned ticket like the one a suggestion is for (see `AgentSettingStats`). */
export interface SimilarTicket {
  id: string
  number: number
  title: string
  /** How alike it is, from 0 to 1: shared tags and title words, and a similar number of checklist steps. */
  similarity: number
  /** Whether it was finished (done column or merged pull request) rather than cancelled or closed unmerged. */
  finished: boolean
  /** Its runs' cost in US dollars; null when none reported one. */
  costUsd: number | null
  tokens: number
}

/** How tickets like a new one went at one model and effort (`GET /boards/:id/agent-suggestion`). */
export interface AgentSettingStats {
  model: string
  effort: AgentEffort
  /** How many similar tickets were worked at it, and how many of them were finished. */
  tickets: number
  finished: number
  /** The share of them that was finished, weighted by similarity: from 0 to 1. */
  successRate: number
  /** Cost per ticket in US dollars, averaged by similarity over those that reported one; null when none did. */
  costUsd: number | null
  /** Tokens per ticket, averaged by similarity. */
  tokens: number
  /** Those tickets, most similar first (at most 5). */
  similar: SimilarTicket[]
}

/**
 * The model and effort to work a new ticket at, from how similar tickets went (`GET /boards/:id/agent-suggestion`):
 * the cheapest setting whose success rate is close to the best one. Null when no similar ticket was ever finished.
 */
export interface AgentSuggestion {
  suggestion: AgentSettingStats | null
  /** Every setting similar tickets were worked at, the suggestion first, then by success rate and cost. */
  options: AgentSettingStats[]
}

/**
 * An agent run working a ticket, as its heartbeats (`POST /tickets/:id/heartbeat`) tell. It ends when the agent says
 * so (`DELETE /tickets/:id/heartbeat`) or after `AGENT_IDLE_MINUTES` without a heartbeat.
 */
export interface AgentRun {
  /** When the run's first heartbeat came. */
  startedAt: string
  /** Its latest heartbeat. */
  seenAt: string
  /** What the run is doing, as its agent last said, e.g. "Answering review feedback". */
  step: string | null
}

export interface BoardDetail {
  board: BoardSummary
  columns: Column[]
  tags: Tag[]
  /** Oldest first. */
  epics: Epic[]
  tickets: Ticket[]
  /** Archived tickets left out of `tickets`; 0 when they were asked for. */
  archivedCount: number
}

export type Activity =
  | ActivityBase<'created', { column: string }>
  | ActivityBase<'updated', { fields: string[] }>
  | ActivityBase<'checked', { item: string; checked: boolean }>
  | ActivityBase<'moved', { from: string; to: string }>
  | ActivityBase<'claimed', { assignee: string }>
  | ActivityBase<'released', { assignee: string }>
  /** `pullRequestComment`: the URL of the same comment posted on the pull request. */
  | ActivityBase<'comment', { body: string; pullRequestComment?: string }>
  | ActivityBase<'plan', { body: string; estimate: TicketSize; held: boolean }>
  | ActivityBase<'approved', { estimate: TicketSize | null }>
  | ActivityBase<'attachment', { attachmentId: string; filename: string; contentType: AttachmentType }>
  | ActivityBase<'pull_request', { url: string; event: 'linked' | 'unlinked' | Exclude<PullRequestState, 'unknown'> }>

export type ActivityType = Activity['type']

/** Tokens an agent used, split the way Claude reports them. */
export interface TokenCounts {
  /** Uncached input. */
  inputTokens: number
  outputTokens: number
  /** Input read from the prompt cache. */
  cacheReadTokens: number
  /** Input written to the prompt cache. */
  cacheWriteTokens: number
}

export const totalTokens = (counts: TokenCounts) =>
  counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens

/** Tokens one model used within an agent run. */
export interface ModelUsage extends TokenCounts {
  /** As the agent reported it, e.g. `claude-opus-5-5`. */
  model: string
  costUsd: number | null
}

/** Tokens one agent run used on a ticket (`POST /tickets/:id/usage`) or a board (`POST /boards/:id/usage`). */
export interface TokenUsage extends TokenCounts {
  id: number
  boardId: string
  /** `null` for runs that weren't on a ticket. */
  ticketId: string | null
  agent: string
  /** Estimated cost in US dollars, when the agent reports one. */
  costUsd: number | null
  /** How long the run took. */
  durationMs: number | null
  /** The run's tokens split by the models that used them, most first; empty when the agent didn't report that. */
  models: ModelUsage[]
  createdAt: string
}

/** Token counts added up over several runs. */
export interface UsageCounts extends TokenCounts {
  /**
   * Estimated cost in US dollars of the runs that reported one; null when none did, e.g. an agent on a local model or
   * one that doesn't know its cost.
   */
  costUsd: number | null
  runs: number
}

/** Token usage added up over several runs, in all and per model. */
export interface UsageTotals extends UsageCounts {
  /** By model name; a run that used several models counts as a run of each. */
  models: Record<string, UsageCounts>
}

const noCounts = (): UsageCounts => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
  runs: 0,
})

export const noUsage = (): UsageTotals => ({ ...noCounts(), models: {} })

function addCounts(totals: UsageCounts, counts: TokenCounts & { costUsd: number | null }, runs: number) {
  totals.inputTokens += counts.inputTokens
  totals.outputTokens += counts.outputTokens
  totals.cacheReadTokens += counts.cacheReadTokens
  totals.cacheWriteTokens += counts.cacheWriteTokens
  if (counts.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + counts.costUsd
  totals.runs += runs
}

/** Adds a run's usage to `totals` and returns them. */
export function addUsage(totals: UsageTotals, run: TokenCounts & { costUsd: number | null; models: ModelUsage[] }) {
  addCounts(totals, run, 1)
  for (const model of run.models) addCounts((totals.models[model.model] ??= noCounts()), model, 1)
  return totals
}

/** Adds `more` totals to `totals` and returns them. */
export function mergeUsage(totals: UsageTotals, more: UsageTotals) {
  addCounts(totals, more, more.runs)
  for (const [model, counts] of Object.entries(more.models)) {
    addCounts((totals.models[model] ??= noCounts()), counts, counts.runs)
  }
  return totals
}

/** Stands for the model of runs that didn't report theirs and don't have it in their agent's name. */
export const UNKNOWN_MODEL = 'unknown'

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

/** Day ranges `GET /api/overview` accepts. */
export const OVERVIEW_RANGES = [7, 14, 30] as const
export type OverviewRange = (typeof OVERVIEW_RANGES)[number]

/**
 * `working` while a ticket is assigned and outside the board's review and done columns, `review` while it waits
 * in the review column.
 */
export type WorkState = 'working' | 'review'

export interface OverviewTicket {
  id: string
  boardId: string
  boardName: string
  number: number
  title: string
  column: string
  state: WorkState
  /** When the ticket entered its current state. */
  since: string
  /** When its agent started waiting on an answer or approval (see `Ticket.waitingSince`). */
  waitingSince: string | null
  /** Whether its agent's plan waits for approval or has it (see `Ticket.approval`). */
  approval: Approval | null
  pullRequest: Pick<PullRequest, 'url' | 'state'> | null
}

export interface OverviewAgent {
  name: string
  /** `working` if any of its tickets is being worked, `review` if all of them wait for review, else `idle`. */
  status: WorkState | 'idle'
  /** Assigned tickets that aren't done, working ones first. */
  tickets: OverviewTicket[]
  /** Time spent working tickets within the range, in milliseconds (ongoing work counts up to `generatedAt`). */
  workedMs: number
  /** Tickets that reached the done column while assigned to it, within the range. */
  completed: number
  /** Activity entries it authored within the range. */
  actions: number
  lastActiveAt: string | null
  /** Boards whose host agent runs under this name. */
  agentOf: string[]
  /** Tokens its runs used within the range. */
  usage: UsageTotals
}

export interface OverviewBoard {
  id: string
  name: string
  agentEnabled: boolean
  agentName: string | null
  /** Tickets outside the done column. */
  open: number
  working: number
  review: number
  /** Tickets that reached the done column within the range. */
  completed: number
  /** Activity entries within the range. */
  events: number
  /** Tokens agents used on its tickets within the range. */
  tokens: number
  lastActivityAt: string | null
}

/** How an activity entry counts in the overview's timeline. */
export type OverviewEventKind = 'created' | 'completed' | 'comment' | 'update'

export interface OverviewEvent {
  at: string
  kind: OverviewEventKind
  actor: string
  boardId: string
}

/** A stretch of time an agent spent working a ticket, clipped to the range; `end` is null while ongoing. */
export interface WorkSession {
  agent: string
  ticketId: string
  boardId: string
  start: string
  end: string | null
}

/** A ticket reaching the done column within the range. */
export interface OverviewCompletion {
  ticketId: string
  boardId: string
  at: string
  /** From when work on it started (it was first assigned outside the review and done columns) to done. */
  cycleMs: number | null
  /** From when it last entered the review column to done, if it went straight from review to done. */
  reviewMs: number | null
}

/** An agent run's token usage within the range. */
export interface OverviewUsage extends TokenCounts {
  at: string
  agent: string
  /** `null` for runs that weren't on a ticket. */
  ticketId: string | null
  boardId: string
  costUsd: number | null
  /**
   * Split by model. Runs that didn't report it count as a run of the model in the agent's name (see `workerModel`),
   * or of `UNKNOWN_MODEL`.
   */
  models: ModelUsage[]
}

/** A ticket agents' runs used tokens on within the range, with its usage over all its runs. */
export interface OverviewTicketUsage {
  id: string
  boardId: string
  boardName: string
  number: number
  title: string
  column: string
  tags: Tag[]
  usage: TicketUsage
}

export type OverviewActivity = Activity & {
  ticket: { number: number; title: string; boardId: string; boardName: string }
}

export interface Overview {
  generatedAt: string
  /** Start of the range. */
  since: string
  days: OverviewRange
  totals: {
    boards: number
    open: number
    working: number
    review: number
    completed: number
    /** Agents working a ticket right now: one per ticket, so parallel runs under one name each count. */
    activeAgents: number
    workedMs: number
    usage: UsageTotals
  }
  agents: OverviewAgent[]
  /** Agents cleared from the overview that haven't done anything since; they aren't in `agents`. */
  hiddenAgents: string[]
  boards: OverviewBoard[]
  /** Every activity entry within the range, oldest first. */
  events: OverviewEvent[]
  sessions: WorkSession[]
  /** Tickets that reached the done column within the range, oldest first. */
  completions: OverviewCompletion[]
  /** Agent runs' token usage within the range, oldest first. */
  usage: OverviewUsage[]
  /** Tickets with runs within the range, most tokens first. */
  tickets: OverviewTicketUsage[]
  /** The latest activity entries across all boards, newest first. */
  recent: OverviewActivity[]
}

/**
 * Updating ultrakanban itself, done on the host by the agent supervisor (`scripts/agent-supervisor.sh`): someone asks
 * for it in the app (`requested`), the supervisor picks it up (`running`), pulls the checkout, rebuilds and restarts
 * the board, and reports how it went (`done` or `failed`).
 */
export const APP_UPDATE_STATES = ['idle', 'requested', 'running', 'done', 'failed'] as const
export type AppUpdateState = (typeof APP_UPDATE_STATES)[number]

export interface AppUpdate {
  state: AppUpdateState
  requestedAt: string | null
  requestedBy: string | null
  /** When it last finished, done or failed. */
  finishedAt: string | null
  /** What the supervisor last said about it: the new version, or why it failed. */
  message: string | null
  /** When the supervisor last checked in; null if it never has, so nothing would act on a request. */
  updaterSeenAt: string | null
  /** The checkout's commit, as `<short sha> <subject>`. */
  version: string | null
  /** Commits the checkout's default branch is behind origin, as of the supervisor's last fetch. */
  behind: number | null
}

/** One of the Claude plan's usage limits: the current session, the week, or the week for one model. */
export interface ClaudeUsageLimit {
  label: string
  /** How much of it is used, 0 to 100. */
  percent: number
  /** When it resets; null if it isn't running (no usage yet in the window). */
  resetsAt: string | null
}

/**
 * How much Claude usage is left, as the agent supervisor (`scripts/agent-supervisor.sh`, on the host) last read it from
 * Claude's usage endpoint with the host's claude login.
 */
export interface ClaudeUsage {
  /** When the supervisor last reported; null if it never has. */
  reportedAt: string | null
  /** The subscription, e.g. "pro" or "max". */
  plan: string | null
  limits: ClaudeUsageLimit[]
  /** Why the last report has no limits, e.g. no claude login on the host. */
  error: string | null
}

/** Where the board's GitHub token comes from: set on the Setup page, `GITHUB_TOKEN`, or the GitHub CLI's login. */
export type GitHubAuthSource = 'board' | 'env' | 'gh'

/** Logins the agent supervisor can run where the agents run, when asked to on the Setup page. */
export const AGENT_LOGIN_KINDS = ['github', 'claude'] as const
export type AgentLoginKind = (typeof AGENT_LOGIN_KINDS)[number]

/**
 * A login the agent supervisor runs for the agents (`gh auth login` or `claude auth login`), asked for on the Setup page:
 * `requested`, then `waiting` once it shows what to do (GitHub's one-time code, or Claude's sign-in link, whose code is
 * pasted back on the page), `checking` while it finishes, then `done` or `failed`.
 */
export const AGENT_LOGIN_STATES = ['requested', 'waiting', 'checking', 'done', 'failed'] as const
export type AgentLoginState = (typeof AGENT_LOGIN_STATES)[number]

export interface AgentLogin {
  kind: AgentLoginKind
  state: AgentLoginState
  requestedAt: string
  /** Where to sign in: github.com/login/device, or Claude's sign-in link. */
  url: string | null
  /** GitHub's one-time code, to enter at `url`. */
  userCode: string | null
  /** Whether Claude's code was pasted and waits for the supervisor. */
  codeSent: boolean
  /** Why it failed, or what it logged in as. */
  message: string | null
  updatedAt: string
}

/** The agent supervisor (`scripts/agent-supervisor.sh`) and the logins the agents have, as it last checked in. */
export interface AgentHost {
  /** When it last checked in; null if it never has. */
  seenAt: string | null
  /** `machine`: as services on the host itself; `container`: in the agents container. */
  runsIn: 'machine' | 'container' | null
  /** The GitHub account gh is logged in as; null if it isn't. */
  githubLogin: string | null
  /** The Claude account claude is logged in as (its email, or `token` for `CLAUDE_CODE_OAUTH_TOKEN`); null if it isn't. */
  claudeAccount: string | null
  /** git's commit name and email, as `Name <email>`; null when not set, so commits would fail. */
  gitIdentity: string | null
  /** The latest login asked for, if any. */
  login: AgentLogin | null
}

/** What the Setup page shows: the board's GitHub access and the agents'. */
export interface SetupStatus {
  github: {
    auth: GitHubAuthSource | null
    /** The account the token belongs to; null without a token, or if GitHub turned it down (`error`). */
    login: string | null
    error: string | null
  }
  agents: AgentHost
  /**
   * The server's time when it answered: the page judges the agents' check-in by it, since the server's clock can be off
   * from the browser's (Docker Desktop's VM's drifts, e.g. after the machine sleeps).
   */
  serverTime: string
}
