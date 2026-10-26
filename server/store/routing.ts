import { parseChecklist } from '../../shared/checklist.ts'
import {
  AGENT_DEFAULTS,
  type AgentEffort,
  HISTORY_MIN_TICKETS,
  JEV_AGENT,
  JEV_DEFAULTS,
  JEV_INPUT_USD_PER_MILLION,
  parseWorkerName,
  ROUTING_MIN_FINISHED,
  ROUTING_MIN_SETTING_TICKETS,
  type RoutedSetting,
  type RoutedSource,
  type RoutingComparison,
  type RoutingPick,
  type RoutingSource,
  type RoutingSourceStats,
  type RunRouting,
  type Ticket,
  type TokenCounts,
  weightedTokens,
  workerSetting,
} from '../../shared/domain.ts'
import type { RecordUsage } from '../../shared/schemas.ts'
import { JEV_MODEL, type JevUsage } from '../jev.ts'
import { now, sql } from '../db.ts'
import { getBoard } from './boards.ts'
import { decidedTickets, suggestAgent } from './suggestions.ts'
import { getTicket } from './tickets.ts'
import { recordUsage } from './usage.ts'

interface RouteRow {
  ticket_id: string
  source: RoutingSource
  model: string
  effort: AgentEffort
  confidence: number | null
  default_model: string
  default_effort: AgentEffort
  history_model: string | null
  history_effort: AgentEffort | null
  jev_model: string | null
  jev_effort: AgentEffort | null
  jev_confidence: number | null
  content_key: string | null
  created_at: string
}

type Setting = { model: string; effort: string }

const sameSetting = (a: Setting, b: Setting) => a.model === b.model && a.effort === b.effort
const settingKey = (setting: Setting) => `${setting.model}/${setting.effort}`

/** The model and effort the board's agent works tickets at when they don't name their own. */
export function boardDefault(boardId: string): { model: string; effort: AgentEffort } {
  const board = getBoard(boardId)
  return { model: board.agentModel ?? AGENT_DEFAULTS.model, effort: board.agentEffort ?? AGENT_DEFAULTS.effort }
}

/** Jev's usage of one request, as a run on the ticket it routed, priced at what TypeSafe charges. */
const jevRun = (usage: JevUsage): RecordUsage => {
  const tokens = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  const counts = { ...tokens, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const costUsd = (usage.inputTokens * JEV_INPUT_USD_PER_MILLION) / 1_000_000
  return {
    agent: JEV_AGENT,
    ...counts,
    costUsd,
    apiKey: false,
    durationMs: null,
    models: [{ model: JEV_MODEL, ...counts, costUsd }],
  }
}

const jevPick = (row: Pick<RouteRow, 'jev_model' | 'jev_effort' | 'jev_confidence'>): RoutingPick | null =>
  row.jev_model && row.jev_effort
    ? { model: row.jev_model, effort: row.jev_effort, confidence: row.jev_confidence }
    : null

/** The history suggestion's pick for the ticket, when it is built on enough similar tickets to route with. */
export function historyPick(ticket: Ticket): { model: string; effort: AgentEffort } | null {
  const { suggestion } = suggestAgent(ticket.boardId, {
    title: ticket.title,
    tag: ticket.tagIds,
    steps: parseChecklist(ticket.description).length,
    estimate: ticket.estimate ?? undefined,
  })
  return suggestion && suggestion.tickets >= HISTORY_MIN_TICKETS
    ? { model: suggestion.model, effort: suggestion.effort }
    : null
}

/**
 * The model and effort the newest run of the board's agent on the ticket worked at; null when it has none. Routing
 * never goes below it, so a ticket whose run failed or that came back with changes requested keeps or raises it.
 */
export function lastRunSetting(ticket: Ticket): { model: string; effort: AgentEffort } | null {
  const agent = getBoard(ticket.boardId).agentName ?? AGENT_DEFAULTS.name
  const runs = sql.all<{ agent: string }>(
    'SELECT agent FROM token_usage WHERE ticket_id = ? ORDER BY created_at DESC, id DESC',
    ticket.id,
  )
  for (const run of runs) {
    const setting = workerSetting(run.agent)
    if (setting && parseWorkerName(run.agent)?.agent === agent) return setting
  }
  return null
}

/** Jev's pick recorded for the ticket when its content had `contentKey` (see `saveRoute`); null when there is none. */
export function cachedJevPick(ticketId: string, contentKey: string): RoutingPick | null {
  const route = sql.get<RouteRow>(
    'SELECT * FROM ticket_routes WHERE ticket_id = ? AND content_key = ? AND jev_model IS NOT NULL',
    ticketId,
    contentKey,
  )
  return route ? jevPick(route) : null
}

/**
 * Records how a ticket that was just claimed is routed (docs/JEV.md, item 8): the setting it is worked at and where it
 * came from (`routed` on a board that routes with Jev, else its own setting or the board's default), and what the
 * history suggestion and Jev (`jev`, asked beforehand on a board that routes with it) picked, so the sources can be
 * compared later. Jev's tokens (`jevUsage`, when it was asked this time) are recorded as a run on the ticket, and its
 * pick is kept with the `contentKey` of what it was told, so it isn't asked again until the ticket changes.
 */
export function saveRoute(
  ticketId: string,
  jev: RoutingPick | null,
  jevUsage: JevUsage | null,
  { routed = null, contentKey = null }: { routed?: RoutedSetting | null; contentKey?: string | null } = {},
) {
  const ticket = getTicket(ticketId)
  const fallback = boardDefault(ticket.boardId)
  const own = ticket.agentModel !== null || ticket.agentEffort !== null
  const used =
    routed ??
    (own ? { model: ticket.agentModel ?? fallback.model, effort: ticket.agentEffort ?? fallback.effort } : fallback)
  const history = historyPick(ticket)
  if (jevUsage) recordUsage(ticket.id, jevRun(jevUsage))
  sql.run(
    `INSERT OR REPLACE INTO ticket_routes
       (ticket_id, source, model, effort, confidence, default_model, default_effort, history_model, history_effort,
        jev_model, jev_effort, jev_confidence, content_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ticket.id,
    routed?.source ?? (own ? 'ticket' : 'default'),
    used.model,
    used.effort,
    routed?.confidence ?? null,
    fallback.model,
    fallback.effort,
    history?.model ?? null,
    history?.effort ?? null,
    jev?.model ?? null,
    jev?.effort ?? null,
    jev?.confidence ?? null,
    jev ? contentKey : null,
    now(),
  )
}

/** A run's routing as recorded with its usage (see `RunRouting`). */
export function toRunRouting(row: {
  routing_source: RoutingSource | null
  routing_confidence: number | null
  jev_model: string | null
  jev_effort: AgentEffort | null
  jev_confidence: number | null
}): RunRouting | null {
  return row.routing_source
    ? { source: row.routing_source, confidence: row.routing_confidence, jev: jevPick(row) }
    : null
}

/**
 * How a run by `agent` on the ticket was routed: by the source the ticket's route says, when it worked at that
 * setting; else by the ticket's own setting or the board's default, whichever it worked at. Null for runs of another
 * agent than the board's, and ones at a setting no source picked (someone ran it by hand at another one).
 */
export function runRouting(ticketId: string, agent: string): RunRouting | null {
  const setting = workerSetting(agent)
  if (!setting) return null
  const ticket = getTicket(ticketId)
  if (parseWorkerName(agent)?.agent !== (getBoard(ticket.boardId).agentName ?? AGENT_DEFAULTS.name)) return null
  const route = sql.get<RouteRow>('SELECT * FROM ticket_routes WHERE ticket_id = ?', ticketId)
  const jev = route ? jevPick(route) : null
  if (route && sameSetting(route, setting)) return { source: route.source, confidence: route.confidence, jev }
  const fallback = boardDefault(ticket.boardId)
  const own = { model: ticket.agentModel ?? fallback.model, effort: ticket.agentEffort ?? fallback.effort }
  if ((ticket.agentModel !== null || ticket.agentEffort !== null) && sameSetting(own, setting)) {
    return { source: 'ticket', confidence: null, jev }
  }
  if (sameSetting(fallback, setting)) return { source: 'default', confidence: null, jev }
  return null
}

interface UsageRow {
  ticket_id: string
  agent: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number | null
}

const counts = (row: UsageRow): TokenCounts => ({
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteTokens: row.cache_write_tokens,
})

/** What a ticket's runs cost: in US dollars, null unless every run reported a cost, and in weighted tokens. */
interface Cost {
  costUsd: number | null
  weightedTokens: number
}

/** How a decided ticket went: whether it was finished (1 or 0, or a success rate when estimated) and its cost. */
interface Outcome extends Cost {
  finished: number
}

/** Tickets decided at one setting, added up. */
interface SettingTotals extends Cost {
  tickets: number
  finished: number
}

type SourceTotals = Omit<RoutingSourceStats, 'source' | 'successRate' | 'costPerFinished'>

const ROUTED_SOURCES: readonly RoutedSource[] = ['jev', 'history', 'default']

const noTotals = (): SourceTotals => ({
  tickets: 0,
  picked: 0,
  worked: 0,
  unmeasured: 0,
  finished: 0,
  costUsd: 0,
  weightedTokens: 0,
})

const addCost = (total: number | null, cost: number | null) => (total === null || cost === null ? null : total + cost)

/** Adds how the board's routed tickets would have gone at each source's picks to `totals`. */
function addBoard(boardId: string, totals: Record<RoutedSource, SourceTotals>, jev: RoutingComparison['jev']) {
  const board = getBoard(boardId)
  const agent = board.agentName ?? AGENT_DEFAULTS.name
  const threshold = board.jevThreshold ?? JEV_DEFAULTS.threshold
  const finished = new Map(decidedTickets(boardId).map((row) => [row.id, !!row.finished]))

  // Each decided ticket's cost over all its runs, and the tokens of each agent name that worked it.
  const costs = new Map<string, Cost>()
  const workers = new Map<string, Map<string, number>>()
  for (const row of sql.all<UsageRow>(
    `SELECT ticket_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
     FROM token_usage WHERE board_id = ? AND ticket_id IS NOT NULL`,
    boardId,
  )) {
    if (row.agent === JEV_AGENT) {
      jev.calls++
      jev.costUsd += row.cost_usd ?? 0
      continue
    }
    if (!finished.has(row.ticket_id)) continue
    const weighted = weightedTokens(counts(row))
    const cost = costs.get(row.ticket_id) ?? { costUsd: 0, weightedTokens: 0 }
    costs.set(row.ticket_id, {
      costUsd: addCost(cost.costUsd, row.cost_usd),
      weightedTokens: cost.weightedTokens + weighted,
    })
    const byAgent = workers.get(row.ticket_id) ?? new Map<string, number>()
    byAgent.set(row.agent, (byAgent.get(row.agent) ?? 0) + weighted)
    workers.set(row.ticket_id, byAgent)
  }

  // As in the history suggestion, the setting of the worker that used the most tokens on a ticket did most of its
  // work, and tickets another agent did most of the work on are left out.
  const outcomes = new Map<string, { setting: Setting; outcome: Outcome }>()
  const settings = new Map<string, SettingTotals>()
  for (const [ticketId, byAgent] of workers) {
    const main = [...byAgent]
      .filter(([name]) => workerSetting(name))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    if (!main || parseWorkerName(main[0])?.agent !== agent) continue
    const setting = workerSetting(main[0])!
    const outcome = { finished: finished.get(ticketId) ? 1 : 0, ...costs.get(ticketId)! }
    outcomes.set(ticketId, { setting, outcome })
    const key = settingKey(setting)
    const stats = settings.get(key) ?? { tickets: 0, finished: 0, costUsd: 0, weightedTokens: 0 }
    settings.set(key, {
      tickets: stats.tickets + 1,
      finished: stats.finished + outcome.finished,
      costUsd: addCost(stats.costUsd, outcome.costUsd),
      weightedTokens: stats.weightedTokens + outcome.weightedTokens,
    })
  }

  /** How a ticket worked at `actual` would have gone at `pick`: as it went, or at the board's average for the pick. */
  const outcomeAt = (pick: Setting, actual: { setting: Setting; outcome: Outcome }): Outcome | null => {
    if (sameSetting(pick, actual.setting)) return actual.outcome
    const stats = settings.get(settingKey(pick))
    if (!stats || stats.tickets < ROUTING_MIN_SETTING_TICKETS) return null
    return {
      finished: stats.finished / stats.tickets,
      costUsd: stats.costUsd === null ? null : stats.costUsd / stats.tickets,
      weightedTokens: stats.weightedTokens / stats.tickets,
    }
  }

  for (const route of sql.all<RouteRow>(
    'SELECT * FROM ticket_routes WHERE ticket_id IN (SELECT id FROM tickets WHERE board_id = ?)',
    boardId,
  )) {
    const actual = outcomes.get(route.ticket_id)
    if (!actual) continue
    const fallback = { model: route.default_model, effort: route.default_effort }
    const history = route.history_model ? { model: route.history_model, effort: route.history_effort! } : null
    const fromJev = jevPick(route)
    const jevAbove = fromJev && (fromJev.confidence ?? 0) >= threshold ? fromJev : null
    // Each source's own pick, and the one it would have routed with: below Jev's threshold, routing falls back to the
    // history suggestion, and without one to the board's default.
    const picks: Record<RoutedSource, [Setting | null, Setting]> = {
      jev: [jevAbove, jevAbove ?? history ?? fallback],
      history: [history, history ?? fallback],
      default: [fallback, fallback],
    }
    for (const source of ROUTED_SOURCES) {
      const [own, pick] = picks[source]
      const total = totals[source]
      if (own) total.picked++
      const outcome = outcomeAt(pick, actual)
      if (!outcome) {
        total.unmeasured++
        continue
      }
      total.tickets++
      if (sameSetting(pick, actual.setting)) total.worked++
      total.finished += outcome.finished
      total.costUsd = addCost(total.costUsd, outcome.costUsd)
      total.weightedTokens += outcome.weightedTokens
    }
  }
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places

/**
 * Compares routing sources on the boards' tickets that were decided since routing was recorded: the cost per finished
 * ticket had Jev (above the board's threshold), the history suggestion or the default picked every setting. A ticket
 * worked at the setting a source picked counts as it went, one worked at another setting at the board's average for
 * the pick. Costs are in US dollars when every counted run reported one, else in tokens weighted by kind.
 */
export function compareRouting(boardIds: string[]): RoutingComparison {
  const totals = { jev: noTotals(), history: noTotals(), default: noTotals() }
  const jev = { calls: 0, costUsd: 0 }
  for (const boardId of boardIds) addBoard(boardId, totals, jev)

  const compared = ROUTED_SOURCES.filter((source) => source === 'default' || totals[source].picked > 0)
  const unit = compared.every((source) => totals[source].costUsd !== null) ? 'usd' : 'tokens'
  const sources = compared
    .map((source): RoutingSourceStats => {
      const total = totals[source]
      const cost = unit === 'usd' ? total.costUsd! : total.weightedTokens
      return {
        source,
        ...total,
        finished: round(total.finished, 2),
        successRate: total.tickets ? round(total.finished / total.tickets, 3) : null,
        costUsd: total.costUsd === null ? null : round(total.costUsd, 6),
        weightedTokens: Math.round(total.weightedTokens),
        costPerFinished: total.finished ? round(cost / total.finished, unit === 'usd' ? 6 : 0) : null,
      }
    })
    .sort((a, b) => (a.costPerFinished ?? Infinity) - (b.costPerFinished ?? Infinity) || 0)
  const settled =
    sources.length > 1 &&
    sources.every((source) => source.costPerFinished !== null && source.finished >= ROUTING_MIN_FINISHED)
  return {
    unit,
    sources,
    verdict: settled ? sources[0].source : null,
    jev: { calls: jev.calls, costUsd: round(jev.costUsd, 6) },
  }
}

/** `compareRouting` over every board. */
export const compareAllRouting = () =>
  compareRouting(sql.all<{ id: string }>('SELECT id FROM boards').map((row) => row.id))
