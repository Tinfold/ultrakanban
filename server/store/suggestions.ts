import {
  AGENT_DEFAULTS,
  AGENT_EFFORTS,
  type AgentEffort,
  type AgentSettingStats,
  type AgentSuggestion,
  CANCELLED_COLUMN,
  parseWorkerName,
  type SettingReport,
  type SimilarTicket,
  SUGGESTION_MIN_TICKETS,
  TICKET_SIZES,
  type TicketSize,
  TOKEN_WEIGHTS,
  workerSetting,
} from '../../shared/domain.ts'
import { parseChecklist } from '../../shared/checklist.ts'
import type { AgentSuggestionQuery } from '../../shared/schemas.ts'
import { sql } from '../db.ts'
import { getBoard } from './boards.ts'
import { listColumns, workflowColumns } from './columns.ts'
import { listTags } from './tags.ts'

/**
 * How much shared tags, shared title words, a similar number of checklist steps and a similar plan estimate count
 * towards similarity.
 */
const WEIGHTS = { tags: 0.4, title: 0.4, steps: 0.1, estimate: 0.1 }
/** Only the most similar tickets count, so a large board's loosely related tickets don't drown out the close ones. */
const MOST_SIMILAR = 20
/** A setting counts as successful enough when its success rate is within this of the best one's. */
const SUCCESS_TOLERANCE = 0.2
const SIMILAR_SHOWN = 5

const STOP_WORDS = new Set(
  `the and for with from into onto that this than then when what which who why how not all any are was were can its
   our out off per via too get has have had use using they them their there these those`.split(/\s+/),
)

/** A title's words that say something about it: lowercased, without stop words and plural `s`. */
export function titleWords(title: string): Set<string> {
  const words = title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(
    words
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
      .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)),
  )
}

function jaccard<T>(a: Set<T>, b: Set<T>) {
  let shared = 0
  for (const item of a) if (b.has(item)) shared++
  const all = a.size + b.size - shared
  return all ? shared / all : 0
}

interface Features {
  tags: Set<string>
  words: Set<string>
  steps: number | undefined
  /** The size its agent estimated it at in its plan; null or undefined before it posted one. */
  estimate?: TicketSize | null
}

/**
 * How alike two tickets are, from 0 to 1. Only shared tags or title words make tickets alike; a similar size adds to
 * that but isn't enough alone: a similar number of checklist steps, and a similar plan estimate (1 for the same size,
 * 0.5 one size apart). A size that either ticket lacks is left out of the weighting.
 */
export function similarity(a: Features, b: Features): number {
  const tags = jaccard(a.tags, b.tags)
  const title = jaccard(a.words, b.words)
  if (!tags && !title) return 0
  let total = WEIGHTS.tags * tags + WEIGHTS.title * title
  let weight = WEIGHTS.tags + WEIGHTS.title
  if (a.steps !== undefined && b.steps !== undefined) {
    total += WEIGHTS.steps * (1 - Math.abs(a.steps - b.steps) / Math.max(a.steps, b.steps, 1))
    weight += WEIGHTS.steps
  }
  if (a.estimate && b.estimate) {
    const apart = Math.abs(TICKET_SIZES.indexOf(a.estimate) - TICKET_SIZES.indexOf(b.estimate))
    total += WEIGHTS.estimate * (1 - apart / (TICKET_SIZES.length - 1))
    weight += WEIGHTS.estimate
  }
  return total / weight
}

interface PastTicketRow {
  id: string
  number: number
  title: string
  description: string
  estimate: TicketSize | null
  finished: number
  tag_ids: string | null
}

interface RunTotalsRow {
  ticket_id: string
  agent: string
  tokens: number
  weighted_tokens: number
  cost_usd: number | null
}

/**
 * The board's decided tickets: finished (in the done column or with a merged pull request) or given up on (in the
 * cancelled column, or with its pull request closed unmerged).
 */
export function decidedTickets(boardId: string): PastTicketRow[] {
  const done = workflowColumns(boardId).done ?? listColumns(boardId).at(-1)
  return sql.all<PastTicketRow>(
    `SELECT t.id, t.number, t.title, t.description, t.estimate,
       (t.pr_state = 'merged' OR t.column_id IS ?) AS finished,
       (SELECT group_concat(tag_id) FROM ticket_tags WHERE ticket_id = t.id) AS tag_ids
     FROM tickets t
     WHERE t.board_id = ?
       AND (t.pr_state IN ('merged', 'closed') OR t.column_id IS ? OR t.column_id IN
         (SELECT id FROM columns WHERE board_id = t.board_id AND lower(name) = '${CANCELLED_COLUMN}'))`,
    done?.id ?? null,
    boardId,
    done?.id ?? null,
  )
}

/** A decided ticket with the setting that did most of its work, and what all its runs cost. */
interface PastTicket {
  ticket: SimilarTicket
  /** Its runs' tokens weighted by kind (see `TOKEN_WEIGHTS`). */
  weightedTokens: number
  setting: { model: string; effort: AgentEffort }
}

/** A decided ticket with the setting that did most of its work, and the features similarity is measured on. */
interface WorkedTicket extends PastTicket {
  features: Features
}

/**
 * Tickets of the board that were decided, with the setting that worked them: finished (in the done column or with a
 * merged pull request) or given up on (in the cancelled column, or with its pull request closed unmerged). Tickets
 * still being worked, and ones no run under an `<agent>/<model>/<effort>` name worked, tell nothing and are left out.
 * With `agent`, so are tickets another agent did most of the work on (Codex on GPT, say). Their similarity is 1 until
 * `pastTickets` scores it.
 */
function workedTickets(boardId: string, agent?: string): WorkedTicket[] {
  const rows = decidedTickets(boardId)
  const runs = new Map<string, RunTotalsRow[]>()
  for (const row of sql.all<RunTotalsRow>(
    `SELECT ticket_id, agent,
       sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
       sum(input_tokens * ? + output_tokens * ? + cache_read_tokens * ? + cache_write_tokens * ?) AS weighted_tokens,
       sum(cost_usd) AS cost_usd
     FROM token_usage WHERE board_id = ? AND ticket_id IS NOT NULL GROUP BY ticket_id, agent`,
    TOKEN_WEIGHTS.inputTokens,
    TOKEN_WEIGHTS.outputTokens,
    TOKEN_WEIGHTS.cacheReadTokens,
    TOKEN_WEIGHTS.cacheWriteTokens,
    boardId,
  )) {
    runs.set(row.ticket_id, [...(runs.get(row.ticket_id) ?? []), row])
  }

  return rows.flatMap((row) => {
    const ticketRuns = runs.get(row.id) ?? []
    // The `<agent>/<model>/<effort>` that used the most tokens on it (weighted, as in the routing comparison) did most
    // of its work.
    const main = ticketRuns
      .filter((run) => parseWorkerName(run.agent)?.effort)
      .sort((a, b) => b.weighted_tokens - a.weighted_tokens || a.agent.localeCompare(b.agent))[0]
    const setting =
      main && (agent === undefined || parseWorkerName(main.agent)?.agent === agent) ? workerSetting(main.agent) : null
    if (!setting) return []
    const costs = ticketRuns.flatMap((run) => (run.cost_usd === null ? [] : [run.cost_usd]))
    const costUsd = costs.length
      ? round(
          costs.reduce((sum, cost) => sum + cost, 0),
          6,
        )
      : null
    const ticket = {
      id: row.id,
      number: row.number,
      title: row.title,
      similarity: 1,
      finished: !!row.finished,
      costUsd,
      tokens: ticketRuns.reduce((sum, run) => sum + run.tokens, 0),
    }
    const features = {
      tags: new Set(row.tag_ids?.split(',') ?? []),
      words: titleWords(row.title),
      steps: parseChecklist(row.description).length,
      estimate: row.estimate,
    }
    return { ticket, weightedTokens: ticketRuns.reduce((sum, run) => sum + run.weighted_tokens, 0), setting, features }
  })
}

/**
 * The board's decided tickets that are like `features`, with the setting that worked them. Only tickets the board's
 * agent (`agent`) did most of the work on count: a suggestion sets the model and effort it works a ticket at, and it
 * can't run another agent's.
 */
function pastTickets(boardId: string, agent: string, features: Features): PastTicket[] {
  return workedTickets(boardId, agent).flatMap(({ ticket, weightedTokens, setting, features: theirs }) => {
    const score = similarity(features, theirs)
    return score ? { ticket: { ...ticket, similarity: round(score, 3) }, weightedTokens, setting } : []
  })
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places

/** Average of `value` over `tickets`, weighted by their similarity; null when none has a value. */
function weightedAverage(tickets: PastTicket[], value: (past: PastTicket) => number | null) {
  let total = 0
  let weight = 0
  for (const past of tickets) {
    const amount = value(past)
    if (amount === null) continue
    total += amount * past.ticket.similarity
    weight += past.ticket.similarity
  }
  return weight ? total / weight : null
}

/** What a finished ticket costs at a setting: its cost per ticket over its success rate; null when nothing finished. */
const perFinished = (perTicket: number | null, successRate: number, places: number) =>
  perTicket === null || !successRate ? null : round(perTicket / successRate, places)

/** How `tickets`, all worked at the same setting, went. */
function statsFor(tickets: PastTicket[]): AgentSettingStats {
  const successRate = weightedAverage(tickets, ({ ticket }) => (ticket.finished ? 1 : 0)) ?? 0
  const costUsd = weightedAverage(tickets, ({ ticket }) => ticket.costUsd)
  const weightedTokens = weightedAverage(tickets, (past) => past.weightedTokens) ?? 0
  return {
    ...tickets[0].setting,
    tickets: tickets.length,
    finished: tickets.filter(({ ticket }) => ticket.finished).length,
    successRate: round(successRate, 3),
    costUsd: costUsd === null ? null : round(costUsd, 6),
    costPerFinishedUsd: perFinished(costUsd, successRate, 6),
    tokens: round(weightedAverage(tickets, ({ ticket }) => ticket.tokens) ?? 0, 0),
    weightedTokens: round(weightedTokens, 0),
    weightedTokensPerFinished: perFinished(weightedTokens, successRate, 0),
    similar: tickets.slice(0, SIMILAR_SHOWN).map(({ ticket }) => ticket),
  }
}

/**
 * Whether `a` costs less per finished ticket than `b`: by cost when both reported one, else by weighted tokens. A
 * setting that finished nothing costs the most.
 */
function cheaper(a: AgentSettingStats, b: AgentSettingStats) {
  const byCost = a.costPerFinishedUsd !== null && b.costPerFinishedUsd !== null
  const [x, y] = byCost
    ? [a.costPerFinishedUsd, b.costPerFinishedUsd]
    : [a.weightedTokensPerFinished, b.weightedTokensPerFinished]
  const [first, second] = [x ?? Infinity, y ?? Infinity]
  return first === second ? 0 : first < second ? -1 : 1
}

/**
 * Suggests a model and effort for a new ticket from how the board's similar tickets went: of the settings at least
 * `SUGGESTION_MIN_TICKETS` of them were worked at, the cheapest per finished ticket whose success rate is within
 * `SUCCESS_TOLERANCE` of the best. A cheaper setting that finishes the same kind of work wins; one that keeps getting
 * its work cancelled or closed doesn't, as each finished ticket also pays for the ones it gave up on.
 */
export function suggestAgent(boardId: string, query: AgentSuggestionQuery): Omit<AgentSuggestion, 'routing'> {
  const board = getBoard(boardId)
  const tags = listTags(boardId)
  const tagIds = query.tag.flatMap((ref) => {
    const tag = tags.find((entry) => entry.id === ref || entry.name.toLowerCase() === ref.toLowerCase())
    return tag ? [tag.id] : []
  })
  const features = {
    tags: new Set(tagIds),
    words: titleWords(query.title),
    steps: query.steps,
    estimate: query.estimate,
  }

  const similar = pastTickets(boardId, board.agentName ?? AGENT_DEFAULTS.name, features)
    .sort((a, b) => b.ticket.similarity - a.ticket.similarity || b.ticket.number - a.ticket.number)
    .slice(0, MOST_SIMILAR)
  const bySetting = new Map<string, PastTicket[]>()
  for (const past of similar) {
    const key = `${past.setting.model}/${past.setting.effort}`
    bySetting.set(key, [...(bySetting.get(key) ?? []), past])
  }
  const options = [...bySetting.values()].map(statsFor)

  // A setting worked at fewer similar tickets says more about those tickets than about the setting.
  const sampled = options.filter((option) => option.tickets >= SUGGESTION_MIN_TICKETS)
  const best = Math.max(0, ...sampled.map((option) => option.successRate))
  const suggestion = best
    ? (sampled.filter((option) => option.successRate >= best - SUCCESS_TOLERANCE).sort(cheaper)[0] ?? null)
    : null
  options.sort(
    (a, b) => Number(b === suggestion) - Number(a === suggestion) || b.successRate - a.successRate || cheaper(a, b),
  )
  return { suggestion, options }
}

/**
 * How the boards' decided tickets went at each model and effort that did most of their work, every ticket counting
 * fully: the most tickets first.
 */
export function settingReport(boardIds: string[]): SettingReport[] {
  const bySetting = new Map<string, PastTicket[]>()
  for (const boardId of boardIds) {
    for (const past of workedTickets(boardId)) {
      const key = `${past.setting.model}/${past.setting.effort}`
      bySetting.set(key, [...(bySetting.get(key) ?? []), past])
    }
  }
  return [...bySetting.values()]
    .map((tickets): SettingReport => {
      const { similar: _, ...stats } = statsFor(tickets)
      return stats
    })
    .sort(
      (a, b) =>
        b.tickets - a.tickets ||
        a.model.localeCompare(b.model) ||
        AGENT_EFFORTS.indexOf(a.effort) - AGENT_EFFORTS.indexOf(b.effort),
    )
}
