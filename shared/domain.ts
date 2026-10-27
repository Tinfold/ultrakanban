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
export type AgentModelAlias = (typeof AGENT_MODELS)[number]

/** Whether a model is one of Claude's: an alias (`AGENT_MODELS`) or a full name such as claude-opus-5-5. */
export const isClaudeModel = (model: string) =>
  (AGENT_MODELS as readonly string[]).includes(model) || /^claude-/i.test(model)

/** What a board's agent runs as when the board doesn't say (see scripts/agent-board.sh). */
export const AGENT_DEFAULTS = {
  name: 'claude',
  model: 'opus',
  effort: 'medium',
  concurrency: 1,
  conflictConcurrency: 2,
} as const
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

/** Name of the column (case-insensitive) for tickets not yet ready to work on, counted on each board's summary. */
export const BACKLOG_COLUMN = 'backlog'

/**
 * Name of the column (case-insensitive) the board's agent works its tickets in: the default of the agent loop's
 * IN_PROGRESS_COLUMN, which scripts/agent-board.sh keeps. Someone other than its agent moving a ticket the agent holds
 * into it asks for more work on it, so the board wakes the agent up for it, as for a comment.
 */
export const IN_PROGRESS_COLUMN = 'in progress'

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
/**
 * The combined status of the checks on the pull request's head commit: its check runs (GitHub Actions and other GitHub
 * apps) and its commit statuses (older CI integrations) together. `failing` once any of them didn't pass, otherwise
 * `pending` while any is still running, otherwise `passing`.
 */
export type CheckStatus = (typeof CHECK_STATUSES)[number]

/** Most failing checks a pull request keeps (see `PullRequest.failingChecks`). */
export const MAX_FAILING_CHECKS = 20
/** Failing check runs whose details (annotations or output) are fetched for an excerpt, the first ones by name. */
export const FAILING_CHECK_EXCERPTS = 3
/** Longest excerpt kept of why a check failed. */
export const FAILING_CHECK_EXCERPT_MAX = 600

/**
 * What a check's excerpt says when CI didn't run because of the account's billing (failed payments, a spending limit,
 * used-up minutes), not because the code failed. The billing part of the agent loop's `INFRA_PATTERN`.
 */
const BILLING_FAILURE =
  /billing|spending limit|payments have failed|account is locked|account has been locked|minutes quota|exceeded .*(minutes|quota)/i

/** Whether a failing check failed because of billing (see `BILLING_FAILURE`); false when it has no excerpt. */
export const isBillingFailure = (check: Pick<FailingCheck, 'excerpt'>) =>
  !!check.excerpt && BILLING_FAILURE.test(check.excerpt)

/**
 * A check on the pull request's head commit that didn't pass, counted the way the agent loop counts them
 * (scripts/agent-loop/ci.sh): a check run that completed as `failure`, `timed_out`, `startup_failure` or
 * `action_required`, or a commit status in `failure` or `error`. Cancelled, skipped, neutral and stale ones aren't.
 */
export interface FailingCheck {
  /** The check run's name (e.g. a GitHub Actions job's) or the commit status's context. */
  name: string
  /** How it ended: the check run's conclusion, or the commit status's state. */
  conclusion: string
  /** Where to see it: the check run's or commit status's details page; null when it has none. */
  url: string | null
  /**
   * A short excerpt of why it failed, from the check run's failure annotations or its output's title and summary, at
   * most `FAILING_CHECK_EXCERPT_MAX` characters. Only the first `FAILING_CHECK_EXCERPTS` failing check runs have one
   * (to spare GitHub's rate limit), or all of them while each one's says it failed for billing (see
   * `isBillingFailure`), and commit statuses give their description. Null when there is none.
   */
  excerpt: string | null
}

export interface PullRequest {
  url: string
  /** `owner/name` */
  repo: string
  number: number
  state: PullRequestState
  title: string | null
  /** Whether GitHub last found that it can't merge cleanly into its base branch (only open and draft ones). */
  conflicts: boolean
  /** Combined status of its checks (see `CheckStatus`); `null` when it has none, or isn't open or draft. */
  checks: CheckStatus | null
  /**
   * The checks of its head commit that didn't pass, by name, at most `MAX_FAILING_CHECKS`; empty unless `checks` is
   * `failing`.
   */
  failingChecks: FailingCheck[]
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

/** How a board routes with Jev (see `BoardSummary.jevMode`). */
export const JEV_MODES = ['dry-run', 'on'] as const
export type JevMode = (typeof JEV_MODES)[number]

/**
 * How a board combines Jev's pick with the history suggestion (see `BoardSummary.jevCombine`): `jev-only` never uses
 * the history suggestion, `jev-first` uses it only when Jev has no pick above the threshold, and `higher` / `lower`
 * take the more or the less capable model and effort of the two when both have a pick.
 */
export const JEV_COMBINES = ['jev-only', 'jev-first', 'higher', 'lower'] as const
export type JevCombine = (typeof JEV_COMBINES)[number]

/** Jev routing settings used when a board doesn't set its own. */
export const JEV_DEFAULTS = { threshold: 0.7, mode: 'dry-run' as JevMode, combine: 'jev-first' as JevCombine }

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
  /** The most turns one run of the agent may take (claude's `--max-turns`); no limit when not set. */
  agentMaxTurns: number | null
  /**
   * How many more runs the agent can make at once that only fix merge conflicts (and answer whatever else is new on
   * those tickets), each in its own git worktree, beside `agentConcurrency`: the conflicts that merging one pull request
   * causes in the others are fixed side by side. 0 for none; 2 when not set.
   */
  agentConflictConcurrency: number | null
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
   * Whether auto-merge (and the ready-to-merge notification) goes ahead when the only failing checks failed because of
   * billing (see `isBillingFailure`), e.g. GitHub Actions jobs that weren't started for a spending limit. Pending checks
   * and any other failing check still hold a pull request back.
   */
  ignoreBillingFailures: boolean
  /**
   * Whether the server deletes a pull request's branch on GitHub once the pull request is merged, after moving the open
   * pull requests based on it to the merged one's base. Branches in forks, the default branch and branches that got
   * new commits after the merge are kept.
   */
  deleteMergedBranches: boolean
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
  /**
   * When someone last asked the board's agent loops to clear their checkouts' build output (`POST
   * /boards/:id/agent-cleanup`); each loop does it before its next run, or at once when idle. Null if never asked.
   */
  agentCleanupRequestedAt: string | null
  /**
   * Whether the board routes tickets with Jev (see docs/JEV.md): picks the model and effort for tickets that don't
   * name their own, from their text, which is sent to TypeSafe. Only offered when a TypeSafe API key is set.
   */
  jevEnabled: boolean
  /** Models Jev may pick from; every model in `AGENT_MODELS` when not set. */
  jevModels: AgentModelAlias[] | null
  /** Smallest confidence at which Jev's pick is used; `JEV_DEFAULTS.threshold` when not set. */
  jevThreshold: number | null
  /** Whether Jev may only pick a cheaper setting than the board's default, never a dearer one. */
  jevOnlyLower: boolean
  /** How Jev's pick and the history suggestion combine; `JEV_DEFAULTS.combine` when not set. */
  jevCombine: JevCombine | null
  /**
   * `dry-run` records Jev's pick without using it, `on` uses it. Set to `dry-run` when Jev is first switched on; null
   * until then.
   */
  jevMode: JevMode | null
  /** Open tickets: all but those in the done column or the cancelled one (see `CANCELLED_COLUMN`). */
  ticketCount: number
  /**
   * Open tickets whose agent waits for a person: for approval of its plan, or for an answer to its latest comment.
   */
  waitingCount: number
  /** Tickets in the review column. */
  reviewCount: number
  /** Tickets in the Backlog column (see `BACKLOG_COLUMN`). */
  backlogCount: number
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
  /** The setting Jev picked for it when its agent claimed it and the board worked it at the pick; null otherwise. */
  jevPick: RoutingPick | null
  /** When the ticket entered its current column. */
  movedAt: string
  /** Whether it has been in the board's done column for longer than the board's `archiveDoneDays`. */
  archived: boolean
  /**
   * Why the board's auto-merge hasn't merged its pull request yet (see `AutoMergeWait`): only while the board has
   * auto-merge on, the ticket is in the review column and its pull request is open. Null when it is ready, and merges
   * at auto-merge's next round.
   */
  autoMergeWait: AutoMergeWait | null
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

/**
 * Why the board's auto-merge (`BoardSummary.autoMerge`) isn't merging a ticket's pull request yet, as its latest round
 * found: what keeps it from being ready, or that merging it failed. Auto-merge looks again every minute.
 */
export interface AutoMergeWait {
  /**
   * For people, e.g. "Waiting for checks", "2 checklist items unchecked", "Waits for #41 to merge first", "Branch
   * protection needs an approving review", "Merge conflicts", or "Merging failed: …" with GitHub's answer.
   */
  reason: string
  /**
   * Whether auto-merge tried to merge it and failed (GitHub turned the merge down, or auto-merge itself couldn't run),
   * rather than it not being ready. It is tried again each round, and stays failed until it merges or something else
   * keeps it waiting, so a merge that keeps failing shows.
   */
  failed: boolean
  /** Since when this has been the reason. */
  since: string
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
  /** How the board's routing sources compare, so the suggestion can be weighed against Jev and the default. */
  routing: RoutingComparison
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
  /**
   * When someone asked for the run to stop (`POST /tickets/:id/stop`) and who, until it ends: the agent loop stops it
   * at its next check of the ticket, keeping its session and work, and resumes it once there is new feedback. Null
   * while nobody has.
   */
  stopRequested: { at: string; by: string } | null
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
  /** Someone asked the agent run working the ticket to stop (`POST /tickets/:id/stop`); `step` is what it was doing. */
  | ActivityBase<'stopped', { step: string | null }>
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
  /** Estimated cost in US dollars, when the agent reports one: billed, not estimated, for a run on the API key. */
  costUsd: number | null
  /** Whether the run went on the agents' API key (see `AgentApiKey`) rather than the Claude plan. */
  apiKey: boolean
  /** How long the run took. */
  durationMs: number | null
  /** The run's tokens split by the models that used them, most first; empty when the agent didn't report that. */
  models: ModelUsage[]
  /**
   * Where the model and effort the run worked at came from (see `RunRouting`); null for runs that weren't on a ticket,
   * or whose `<agent>/<model>/<effort>` matches no source's pick.
   */
  routing: RunRouting | null
  createdAt: string
}

/**
 * Where the model and effort a ticket is worked at come from: the ticket's own (`agentModel`/`agentEffort`), Jev's pick
 * (docs/JEV.md), the history suggestion (`GET /boards/:id/agent-suggestion`) or the board's default.
 */
export const ROUTING_SOURCES = ['ticket', 'jev', 'history', 'default'] as const
export type RoutingSource = (typeof ROUTING_SOURCES)[number]

/** A model and effort a routing source picked, with its confidence from 0 to 1 when it has one (Jev's). */
export interface RoutingPick {
  model: string
  effort: AgentEffort
  confidence: number | null
}

/**
 * The model and effort a claimed ticket is worked at on a board that routes with Jev (`jevMode` `on`), and the source
 * that won (docs/JEV.md, item 5): the ticket's own setting, else Jev's pick at or above the board's threshold, else the
 * history suggestion when it is built on `HISTORY_MIN_TICKETS` similar tickets, else the board's default. Returned as
 * `routed` by `claim`, `claim-next` and `POST /tickets/:id/route`; the ticket's own `agentModel`/`agentEffort` stay as
 * they are.
 */
export interface RoutedSetting extends RoutingPick {
  source: RoutingSource
}

/** How an agent run on a ticket was routed, recorded with its usage. */
export interface RunRouting {
  source: RoutingSource
  /** The source's confidence in the setting, when it has one (Jev's). */
  confidence: number | null
  /** What Jev picked for the ticket when it was claimed, used or not (dry run); null when Jev wasn't asked or failed. */
  jev: RoutingPick | null
}

/** The name Jev's own usage is recorded under, on the ticket it routed (see docs/JEV.md). */
export const JEV_AGENT = 'jev'
/** What Jev charges per million input tokens, in US dollars; its output is free. */
export const JEV_INPUT_USD_PER_MILLION = 0.042

/**
 * How much each kind of token counts when runs that reported no cost are compared by their tokens: about what Claude
 * charges for each relative to uncached input. Cache reads are cheap but make up most of a run's raw total.
 */
export const TOKEN_WEIGHTS = { inputTokens: 1, outputTokens: 5, cacheReadTokens: 0.1, cacheWriteTokens: 1.25 } as const

/** A run's tokens weighted by kind (see `TOKEN_WEIGHTS`), in uncached-input tokens. */
export const weightedTokens = (counts: TokenCounts) =>
  counts.inputTokens * TOKEN_WEIGHTS.inputTokens +
  counts.outputTokens * TOKEN_WEIGHTS.outputTokens +
  counts.cacheReadTokens * TOKEN_WEIGHTS.cacheReadTokens +
  counts.cacheWriteTokens * TOKEN_WEIGHTS.cacheWriteTokens

/** The routing sources compared by cost per finished ticket (see `RoutingComparison`). */
export type RoutedSource = Exclude<RoutingSource, 'ticket'>

/**
 * A routing comparison names the cheapest source only once every source compared has at least this many finished
 * tickets: fewer say more about the tickets than about the source.
 */
export const ROUTING_MIN_FINISHED = 10
/**
 * A ticket worked at another setting than a source picked counts at the board's average for the pick: only once the
 * board has decided at least this many tickets at it.
 */
export const ROUTING_MIN_SETTING_TICKETS = 3
/** History routes a ticket only when its suggestion is built on at least this many similar tickets. */
export const HISTORY_MIN_TICKETS = 3

/** How the tickets would have gone had one routing source picked every one of their settings. */
export interface RoutingSourceStats {
  source: RoutedSource
  /** Decided tickets (finished or given up on) counted. */
  tickets: number
  /**
   * Tickets the source picked a setting for itself, counted or `unmeasured`; for the rest it fell back to the next
   * source, as it would when routing (Jev below the board's threshold, or a history suggestion built on too few tickets).
   */
  picked: number
  /**
   * Of those, how many were worked at the setting it picked, so count as they went. The rest count at the board's
   * average for the pick: its cost per ticket and its success rate.
   */
  worked: number
  /** Tickets left out: the source picked a setting the board hasn't decided `ROUTING_MIN_SETTING_TICKETS` at yet. */
  unmeasured: number
  /** Finished tickets; those counted at the board's average count by its success rate, so this may be fractional. */
  finished: number
  /** `finished` out of `tickets`, from 0 to 1; null when no ticket counted. */
  successRate: number | null
  /** Cost of the counted tickets' runs in US dollars; null unless every one of them reported a cost. */
  costUsd: number | null
  /** Their tokens, weighted by kind (see `weightedTokens`). */
  weightedTokens: number
  /** Cost per finished ticket (cost divided by success rate), in the comparison's `unit`; null with none finished. */
  costPerFinished: number | null
}

/**
 * Cost per finished ticket of each routing source on tickets claimed since routing was recorded, so a board can see
 * whether Jev routes better than the history suggestion and the default before trusting it (docs/JEV.md, item 8).
 */
export interface RoutingComparison {
  /** `usd` when every compared source has a cost in US dollars, else `tokens` (weighted by kind). */
  unit: 'usd' | 'tokens'
  /** Every source that picked at least one ticket, and the default; cheapest per finished ticket first. */
  sources: RoutingSourceStats[]
  /**
   * The source with the lowest cost per finished ticket, once at least two are compared and each has
   * `ROUTING_MIN_FINISHED` finished tickets; null until then.
   */
  verdict: RoutedSource | null
  /** What asking Jev cost: its calls and their cost in US dollars (left out of the sources' costs). */
  jev: { calls: number; costUsd: number }
}

export const RUN_OUTCOMES = [
  'finished',
  'failed',
  'timed_out',
  'killed',
  'stopped',
  'stop_requested',
  'loop_stopped',
  'usage_limit',
] as const
/**
 * How an agent run ended: `finished` (the agent exited successfully), `failed` (it exited with an error), `timed_out`
 * (it ran longer than the agent loop's TICKET_TIMEOUT), `killed` (by a signal, most likely the kernel's for running out
 * of memory), `stopped` (the loop stopped it because someone took the ticket away from the agent), `stop_requested`
 * (the loop stopped it because someone asked, see `AgentRun.stopRequested`, and resumes it once there is new feedback),
 * `loop_stopped` (the loop itself was stopped, e.g. restarted, and its next run on the ticket resumes it) or
 * `usage_limit` (the account ran out of Claude usage, so the loop waits for it to reset and then resumes the run).
 */
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

/** Longest final message a run record keeps (see `RunRecord`); longer ones are clipped. */
export const RUN_MESSAGE_MAX = 4000
/** Most steps a run record holds (see `RunRecord`): a long run keeps its first and last ones. */
export const RUN_MAX_STEPS = 150
/** Run records kept per ticket: older ones are deleted as new ones arrive. */
export const RUN_RECORDS_KEPT = 50

/** One tool call of an agent run, condensed for people to skim (see `RunRecord`). */
export interface RunStep {
  /** The tool's name, e.g. `Bash`, `Edit` or `mcp__github__create_pull_request`. */
  tool: string
  /** What it was called on: a command's first line, a file's path, a search pattern. Empty when nothing fits. */
  summary: string
  /** Whether the tool reported an error, e.g. a command that failed or an edit that didn't apply. */
  error: boolean
}

/**
 * What one agent run on a ticket did and how it ended (`POST /tickets/:id/runs`), so people can see what an agent did
 * and why it is stuck without reading the agent loop's logs. The loop reports every run it starts, finished or not,
 * even when the run printed no result (it timed out or was killed).
 */
export interface RunRecord {
  id: number
  ticketId: string
  /** Who ran, e.g. `claude/opus/high`. */
  agent: string
  outcome: RunOutcome
  /** The agent process's exit status; null when the agent doesn't say. */
  exitCode: number | null
  /** How long the run took, start to end. */
  durationMs: number | null
  /** How many turns (responses of the model) the run took. */
  turns: number | null
  /** Estimated cost in US dollars, when the agent reports one: billed, not estimated, for a run on the API key. */
  costUsd: number | null
  /** Whether the run went on the agents' API key (see `AgentApiKey`) rather than the Claude plan. */
  apiKey: boolean
  /**
   * The run's final message (Markdown), or what it last said or printed when it ended without one; at most
   * `RUN_MESSAGE_MAX` characters. Empty when there was nothing.
   */
  message: string
  /** Its tool calls in order (not its subagents'), at most `RUN_MAX_STEPS`. */
  steps: RunStep[]
  /**
   * Tool calls left out of a long run to keep the record small: `count` of them, which came between `steps[after - 1]`
   * and `steps[after]`. Null when none were.
   */
  omittedSteps: { after: number; count: number } | null
  /** When the run was reported, as it ended. */
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

/** Adds a run's usage to `totals` and returns them. A Jev request (`JEV_AGENT`) adds its tokens and cost, not a run. */
export function addUsage(
  totals: UsageTotals,
  run: TokenCounts & { agent?: string; costUsd: number | null; models: ModelUsage[] },
) {
  const runs = run.agent === JEV_AGENT ? 0 : 1
  addCounts(totals, run, runs)
  for (const model of run.models) addCounts((totals.models[model.model] ??= noCounts()), model, runs)
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
  /** Estimated cost in US dollars of those runs, of the ones that reported one; null when none did. */
  costUsd: number | null
  lastActivityAt: string | null
  disk: BoardDiskUsage
}

/** Disk space a board's agent takes where the agents run, in bytes, as the agent supervisor last measured it. */
export interface AgentDiskUsage {
  /** The board's clone. */
  repo: number
  /** The git worktrees of its parallel runs. */
  worktrees: number
  /** The rest: the agent loop's state and the runs' scratch files. */
  state: number
  measuredAt: string
}

/** Disk space a board takes, in bytes. */
export interface BoardDiskUsage {
  /** Its tickets' attachments, on the board's server. */
  attachments: number
  /** Its agent's folder where the agents run; null if the agent supervisor hasn't measured one. */
  agent: AgentDiskUsage | null
}

/** A number of attachments and the bytes they take. */
export interface AttachmentBytes {
  count: number
  bytes: number
}

/** A ticket's attachments, in a board's disk usage. */
export interface TicketAttachmentBytes extends AttachmentBytes {
  ticketId: string
  number: number
  title: string
  /** Whether the ticket is finished: in the done column or the Cancelled one. */
  finished: boolean
}

/** What a board's disk space is made of (`GET /boards/:id/disk-usage`), in bytes. */
export interface BoardDiskBreakdown {
  attachments: {
    /** Screenshots: PNG, JPEG, GIF and WebP. */
    images: AttachmentBytes
    /** Screen recordings: MP4 and WebM. */
    videos: AttachmentBytes
    /** Those of finished tickets (in the done or Cancelled column), which `POST /boards/:id/attachments/cleanup` deletes. */
    finished: AttachmentBytes
    /** The tickets whose attachments take the most space, largest first (at most `DISK_USAGE_TICKETS`). */
    tickets: TicketAttachmentBytes[]
  }
  /** The board's agent folder where the agents run; null if the agent supervisor hasn't measured one. */
  agent: AgentDiskUsage | null
}

/** How many of the largest tickets a board's disk usage lists. */
export const DISK_USAGE_TICKETS = 10

/** What `POST /boards/:id/attachments/cleanup` deleted. */
export type AttachmentCleanup = AttachmentBytes

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
  /** Estimated cost in US dollars of all the agent runs on the ticket, whenever they ran; null when none reported one. */
  costUsd: number | null
}

/** An agent run's token usage within the range. */
export interface OverviewUsage extends TokenCounts {
  at: string
  agent: string
  /** `null` for runs that weren't on a ticket. */
  ticketId: string | null
  boardId: string
  costUsd: number | null
  /** Whether the run went on the agents' API key, its cost billed rather than estimated (see `AgentApiKey`). */
  apiKey: boolean
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
  disk: {
    /** When the agent supervisor last measured the agents' folders; null if it never has. */
    measuredAt: string | null
    /** Bytes in the agents' folders of boards that no longer exist. */
    deletedBoards: number
  }
  /** Every activity entry within the range, oldest first. */
  events: OverviewEvent[]
  sessions: WorkSession[]
  /** Tickets that reached the done column within the range, oldest first. */
  completions: OverviewCompletion[]
  /** Agent runs' token usage within the range, oldest first. */
  usage: OverviewUsage[]
  /** Tickets with runs within the range, most tokens first. */
  tickets: OverviewTicketUsage[]
  /** How routing sources compare on every board, over all time: routing data is slow to build up. */
  routing: RoutingComparison
  /** The latest activity entries across all boards, newest first. */
  recent: OverviewActivity[]
}

/**
 * Updating ultrakanban itself, done on the host by the agent supervisor (`scripts/agent-supervisor.sh`): someone asks
 * for it in the app (`requested`), the supervisor picks it up (`running`), moves the checkout to origin's default
 * branch, rebuilds and restarts the board, and reports how it went (`done` or `failed`).
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
  /** Its commits that aren't on origin: the update keeps them on a backup branch and leaves them out. */
  ahead: number | null
  /** The checkout's full commit sha. */
  commit: string | null
  /** The commit the running board was built from (`ULTRAKANBAN_COMMIT` at build time); null when unknown. */
  runningCommit: string | null
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
 * Money the Claude account can spend on usage besides the plan's limits, in `currency` units, e.g. dollars. Neither
 * kind is API credits, the prepaid balance of a Claude Console organisation that API keys spend: the claude.ai login
 * the board reads usage with can't see that one.
 */
export interface ClaudeUsageCredit {
  /**
   * `grant`: dollars granted to the plan ("Credit grant"). `usage`: usage credits, what claude.ai calls extra usage,
   * bought there and spent once a plan limit is reached, while they are switched on ("Usage credits").
   */
  kind: 'grant' | 'usage'
  /** "Credit grant" or "Usage credits". */
  label: string
  /** Whether usage spends it now: usage credits only while switched on; a grant always. */
  enabled: boolean
  /** e.g. "USD". */
  currency: string
  used: number
  /** How much there is in all (the grant, or extra usage's spending limit); null when it has none. */
  limit: number | null
  /** How much of it is left; null when unknown (extra usage without a spending limit or balance). */
  remaining: number | null
  /** When it resets or runs out; null when it doesn't say. */
  resetsAt: string | null
}

/**
 * Whether a usage limit counts the week, for all models or for one (as opposed to the current session): the labels
 * the board gives them start with "Week" ("Week, all models", "Week, Opus"), or with "weekly" for kinds of limit it
 * doesn't know.
 */
export const isWeeklyLimit = (limit: Pick<ClaudeUsageLimit, 'label'>) => /^week/i.test(limit.label)

/** Whether a usage limit counts the current session, Claude's five-hour window ("Current session"). */
export const isSessionLimit = (limit: Pick<ClaudeUsageLimit, 'label'>) => /session/i.test(limit.label)

/**
 * The usage reserve, one setting for the whole Claude account rather than per board: how far agents may use the week
 * and the current session, each in percent (1 to 100) of its limit, null when off. Past either, agents claim no new
 * tickets (`claim-next`), leaving the rest for the user's own sessions. Tickets agents already hold still get runs for
 * their feedback.
 */
export interface ClaudeUsageReserve {
  /** For the weekly limits, all models and per-model ones alike. */
  week: number | null
  /** For the current session. */
  session: number | null
  /**
   * Whether agents go on claiming new tickets once a limit is used up, with Claude then spending the account's usage
   * credits (see `ClaudeUsageCredit`) when they are on. False (the default) stops claiming there, keeping them for
   * people.
   */
  usageCredits: boolean
}

/** What an agent run on the API key may spend when the setting doesn't say (`AgentApiKey.runBudgetUsd`), in dollars. */
export const DEFAULT_API_KEY_RUN_BUDGET_USD = 5

/**
 * What agents do once Claude usage runs out, one setting for the whole Claude account like the usage reserve: wait
 * until the limit resets (the default), or go on on the agents' API key, `AGENT_API_KEY` in their environment, which
 * never reaches the board. Runs on the key spend the API credits of its Claude Console organisation: money really
 * billed, unlike the estimated cost of runs on the plan.
 */
export interface AgentApiKey {
  /**
   * Whether a run that hits the usage limit is retried on the API key, and runs go on on it until the limit resets,
   * rather than the loop waiting for that. While the key is `usable`, a used-up limit doesn't stop `claim-next` either;
   * the usage reserve still does.
   */
  enabled: boolean
  /** Whether the agents last checked in with a key (`AgentHost.apiKey`). */
  available: boolean
  /** Most a run on the key may spend, in dollars (`claude -p --max-budget-usd`). */
  runBudgetUsd: number
  /** Most runs on the key may spend in a calendar month (UTC), in dollars; null for no cap. */
  monthlyBudgetUsd: number | null
  /** What runs on the key spent this calendar month (UTC), from the cost they reported. */
  spentThisMonthUsd: number
  /** Whether runs may go on on the key now: `enabled`, `available` and under the monthly cap. */
  usable: boolean
}

/** The reserve that applies to a usage limit: the week's to the weekly ones, the session's to the current session. */
export function reserveFor(limit: Pick<ClaudeUsageLimit, 'label'>, reserve: ClaudeUsageReserve) {
  return isWeeklyLimit(limit) ? reserve.week : isSessionLimit(limit) ? reserve.session : null
}

/**
 * How old a usage report can be and still hold agents back with the usage reserve (`ClaudeUsage.reserve`). The
 * supervisor reports every 5 minutes, so an older report means it stopped reporting: agents then claim as usual rather
 * than wait on a number nobody updates.
 */
export const CLAUDE_USAGE_FRESH_MINUTES = 30

/**
 * How much Claude usage is left, as the agent supervisor (`scripts/agent-supervisor.sh`, on the host) last read it from
 * Claude's usage endpoint with the host's claude login, and how much of it agents leave for the user.
 */
export interface ClaudeUsage {
  /** When the supervisor last reported; null if it never has. */
  reportedAt: string | null
  /** The subscription, e.g. "pro" or "max". */
  plan: string | null
  /**
   * When `limits` were read; null if they never were. A report with only an error keeps the last limits, so this can be
   * older than `reportedAt`.
   */
  limitsAt: string | null
  limits: ClaudeUsageLimit[]
  /** The credits the account can spend on usage besides its limits; empty when it has none. */
  credits: ClaudeUsageCredit[]
  /** Why the last report has no usage, e.g. no claude login on the host; the last limits stay until they go stale. */
  error: string | null
  /** How far agents may use the week and the current session (see `ClaudeUsageReserve`). */
  reserve: ClaudeUsageReserve
  /** Whether agents go on on their API key once usage runs out (see `AgentApiKey`). */
  apiKey: AgentApiKey
  /**
   * The limit that holds agents back right now: one at or over its reserve (see `reserveFor`) that hasn't reset since,
   * when the limits are fresh (`limitsAt`, see `CLAUDE_USAGE_FRESH_MINUTES`). Of several, the one that resets last (the most used of
   * those that reset together), as agents claim again only once all of them have. Null otherwise.
   */
  reserveReached: ClaudeUsageLimit | null
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
  /** Whether they have an API key to go on with once Claude usage runs out (`AGENT_API_KEY`, see `AgentApiKey`). */
  apiKey: boolean
  /** The latest login asked for, if any. */
  login: AgentLogin | null
}

/**
 * Every board's agents at once, as the header shows them: switched off (`paused`) or on there, and which loops the agent
 * supervisor last found running. Switched off, the supervisor stops every loop and the containers their runs use, and
 * starts none; switched on again, it starts the loop of every board whose agent is on, as before.
 */
export interface AgentServices {
  paused: boolean
  /**
   * Whether the last switch on asked for the loops that run to be restarted too: stopped, with the containers their
   * runs use, and started again.
   */
  restart: boolean
  /** When it was last switched on or off, and by whom; null if it never has been. */
  changedAt: string | null
  changedBy: string | null
  /** The boards whose agent is on (with a repository): each should have a loop running unless paused. */
  wanted: string[]
  /** The boards whose loop the supervisor last found running. */
  running: string[]
  /**
   * Running loops that can't take any ticket: the boards where claiming one last failed, why (e.g. its in-progress
   * column is gone) and since when. Each stays until a claim there goes through or finds nothing to do. The usage
   * reserve holding agents back (`usage_reserve_reached`) doesn't count as failing.
   */
  claimErrors: AgentClaimError[]
  /** When the supervisor last reported them; null if it never has, so nothing would act on the switch. */
  reportedAt: string | null
  /** The switch (its `changedAt`) the supervisor had seen to when it reported; until it is `changedAt`, it is on its way. */
  handledAt: string | null
  /** The server's time when it answered, to judge `reportedAt` by: the browser's clock can be off from it. */
  serverTime: string
}

/** Why claiming a ticket on a board fails (see `AgentServices`). */
export interface AgentClaimError {
  boardId: string
  message: string
  /** When it first failed this way. */
  since: string
}

/** What the Setup page shows: the board's GitHub access and the agents'. */
export interface SetupStatus {
  github: {
    auth: GitHubAuthSource | null
    /** The account the token belongs to; null without a token, or if GitHub turned it down (`error`). */
    login: string | null
    error: string | null
  }
  /** Where the TypeSafe API key for Jev comes from; null without one, and Jev's features stay hidden. Never the key. */
  typesafe: { source: 'env' | 'board' | null }
  agents: AgentHost
  /**
   * The server's time when it answered: the page judges the agents' check-in by it, since the server's clock can be off
   * from the browser's (Docker Desktop's VM's drifts, e.g. after the machine sleeps).
   */
  serverTime: string
}

/** Jev's answer to `POST /boards/:id/jev-suggestion`: its pick for a ticket and how likely each choice is. */
export interface JevSuggestion {
  model: string
  effort: AgentEffort
  /** The lower of the model's and the effort's confidence, from 0 to 1. */
  confidence: number
  probabilities: {
    model: Record<string, number>
    effort: Record<string, number>
    fullySpecified: number
  }
}
