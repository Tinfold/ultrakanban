import {
  type AgentEffort,
  type AgentSettingStats,
  type AgentSuggestion,
  CANCELLED_COLUMN,
  type SimilarTicket,
  workerSetting,
} from '../../shared/domain.ts'
import { parseChecklist } from '../../shared/checklist.ts'
import type { AgentSuggestionQuery } from '../../shared/schemas.ts'
import { sql } from '../db.ts'
import { getBoard } from './boards.ts'
import { listColumns, workflowColumns } from './columns.ts'
import { listTags } from './tags.ts'

/** How much shared tags, shared title words and a similar number of checklist steps count towards similarity. */
const WEIGHTS = { tags: 0.45, title: 0.45, steps: 0.1 }
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
}

/**
 * How alike two tickets are, from 0 to 1. Only shared tags or title words make tickets alike; a similar number of
 * checklist steps (their size, as far as it is known before anyone estimates it) adds to that but isn't enough alone.
 */
export function similarity(a: Features, b: Features): number {
  const tags = jaccard(a.tags, b.tags)
  const title = jaccard(a.words, b.words)
  if (!tags && !title) return 0
  if (a.steps === undefined || b.steps === undefined) {
    return (WEIGHTS.tags * tags + WEIGHTS.title * title) / (WEIGHTS.tags + WEIGHTS.title)
  }
  const steps = 1 - Math.abs(a.steps - b.steps) / Math.max(a.steps, b.steps, 1)
  return WEIGHTS.tags * tags + WEIGHTS.title * title + WEIGHTS.steps * steps
}

interface PastTicketRow {
  id: string
  number: number
  title: string
  description: string
  finished: number
  tag_ids: string | null
}

interface RunTotalsRow {
  ticket_id: string
  agent: string
  tokens: number
  cost_usd: number | null
}

/** A decided ticket with the setting that did most of its work, and what all its runs cost. */
interface PastTicket {
  ticket: SimilarTicket
  setting: { model: string; effort: AgentEffort }
}

/**
 * Tickets of the board that were decided, with the setting that worked them: finished (in the done column or with a
 * merged pull request) or given up on (in the cancelled column, or with its pull request closed unmerged). Tickets
 * still being worked, and ones no run under an `<agent>/<model>/<effort>` name worked, tell nothing and are left out.
 */
function pastTickets(boardId: string, features: Features): PastTicket[] {
  const done = workflowColumns(boardId).done ?? listColumns(boardId).at(-1)
  const rows = sql.all<PastTicketRow>(
    `SELECT t.id, t.number, t.title, t.description,
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
  const runs = new Map<string, RunTotalsRow[]>()
  for (const row of sql.all<RunTotalsRow>(
    `SELECT ticket_id, agent,
       sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens, sum(cost_usd) AS cost_usd
     FROM token_usage WHERE board_id = ? AND ticket_id IS NOT NULL GROUP BY ticket_id, agent`,
    boardId,
  )) {
    runs.set(row.ticket_id, [...(runs.get(row.ticket_id) ?? []), row])
  }

  return rows.flatMap((row) => {
    const ticketRuns = runs.get(row.id) ?? []
    // The setting that used the most tokens on it did most of its work.
    const main = ticketRuns
      .flatMap((run) => {
        const setting = workerSetting(run.agent)
        return setting ? [{ ...run, setting }] : []
      })
      .sort((a, b) => b.tokens - a.tokens || a.agent.localeCompare(b.agent))[0]
    if (!main) return []
    const score = similarity(features, {
      tags: new Set(row.tag_ids?.split(',') ?? []),
      words: titleWords(row.title),
      steps: parseChecklist(row.description).length,
    })
    if (!score) return []
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
      similarity: round(score, 3),
      finished: !!row.finished,
      costUsd,
      tokens: ticketRuns.reduce((sum, run) => sum + run.tokens, 0),
    }
    return { ticket, setting: main.setting }
  })
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places

/** Weighted average of `value` over `tickets`, by their similarity; null when none has a value. */
function weightedAverage(tickets: SimilarTicket[], value: (ticket: SimilarTicket) => number | null, places: number) {
  let total = 0
  let weight = 0
  for (const ticket of tickets) {
    const amount = value(ticket)
    if (amount === null) continue
    total += amount * ticket.similarity
    weight += ticket.similarity
  }
  return weight ? round(total / weight, places) : null
}

/** How `tickets`, all worked at the same setting, went. */
function statsFor(tickets: PastTicket[]): AgentSettingStats {
  const similar = tickets.map(({ ticket }) => ticket)
  return {
    ...tickets[0].setting,
    tickets: similar.length,
    finished: similar.filter((ticket) => ticket.finished).length,
    successRate: weightedAverage(similar, (ticket) => (ticket.finished ? 1 : 0), 3) ?? 0,
    costUsd: weightedAverage(similar, (ticket) => ticket.costUsd, 6),
    tokens: weightedAverage(similar, (ticket) => ticket.tokens, 0) ?? 0,
    similar: similar.slice(0, SIMILAR_SHOWN),
  }
}

/** Whether `a` costs less per ticket than `b`: by cost when both reported one, else by tokens. */
const cheaper = (a: AgentSettingStats, b: AgentSettingStats) =>
  a.costUsd !== null && b.costUsd !== null ? a.costUsd - b.costUsd : a.tokens - b.tokens

/**
 * Suggests a model and effort for a new ticket from how the board's similar tickets went: of the settings they were
 * worked at, the cheapest one whose success rate is within `SUCCESS_TOLERANCE` of the best. A cheaper setting that
 * finishes the same kind of work wins; one that keeps getting its work cancelled or closed doesn't.
 */
export function suggestAgent(boardId: string, query: AgentSuggestionQuery): AgentSuggestion {
  getBoard(boardId)
  const tags = listTags(boardId)
  const tagIds = query.tag.flatMap((ref) => {
    const tag = tags.find((entry) => entry.id === ref || entry.name.toLowerCase() === ref.toLowerCase())
    return tag ? [tag.id] : []
  })
  const features = { tags: new Set(tagIds), words: titleWords(query.title), steps: query.steps }

  const similar = pastTickets(boardId, features)
    .sort((a, b) => b.ticket.similarity - a.ticket.similarity || b.ticket.number - a.ticket.number)
    .slice(0, MOST_SIMILAR)
  const bySetting = new Map<string, PastTicket[]>()
  for (const past of similar) {
    const key = `${past.setting.model}/${past.setting.effort}`
    bySetting.set(key, [...(bySetting.get(key) ?? []), past])
  }
  const options = [...bySetting.values()].map(statsFor)

  const best = Math.max(0, ...options.map((option) => option.successRate))
  const suggestion = best
    ? (options.filter((option) => option.successRate >= best - SUCCESS_TOLERANCE).sort(cheaper)[0] ?? null)
    : null
  options.sort(
    (a, b) => Number(b === suggestion) - Number(a === suggestion) || b.successRate - a.successRate || cheaper(a, b),
  )
  return { suggestion, options }
}
