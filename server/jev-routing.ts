import { createHash } from 'node:crypto'
import { parseChecklist } from '../shared/checklist.ts'
import {
  AGENT_EFFORTS,
  AGENT_MODELS,
  type AgentEffort,
  type BoardSummary,
  JEV_DEFAULTS,
  type RoutedSetting,
  type RoutingPick,
  type Ticket,
} from '../shared/domain.ts'
import { transaction } from './db.ts'
import { systemOne, type JevAnswer, type JevQuestion, type JevUsage } from './jev.ts'
import { getBoard } from './store/boards.ts'
import { getEpic } from './store/epics.ts'
import { boardDefault, cachedJevPick, historyPick, lastRunSetting, saveRoute } from './store/routing.ts'
import { suggestAgent } from './store/suggestions.ts'
import { listTags } from './store/tags.ts'
import { typesafeKey } from './typesafe.ts'

/**
 * Everything Jev is asked when it routes a ticket (docs/JEV.md, item 4), kept here so it can be tuned in one place.
 * The model criteria follow the skill's guidance on picking `agentModel` (.claude/skills/ultrakanban/SKILL.md).
 */
const MODEL_CRITERIA: Record<string, string> = {
  haiku: 'Mechanical edits where the change is fully spelled out: a rename, bumping a version, fixing a typo.',
  sonnet: 'Routine, well-scoped work: copy and docs, small UI changes, a clear bug with a known cause.',
  opus: 'Changes across several files or areas that need judgment.',
  fable: 'The hardest work: bugs with unknown causes, design or architecture, concurrency, security.',
}
const MODEL_QUESTION = 'Which model should work this ticket? Pick the cheapest one that can do the work well.'

const EFFORT_LEVELS: Record<AgentEffort, string> = {
  low: 'The change is spelled out; little to work out.',
  medium: 'Routine work with a clear scope and a few decisions.',
  high: 'Several areas, open questions, or a bug whose cause has to be found.',
  xhigh: 'Hard design, concurrency or security work that needs deep reasoning.',
  max: 'Exceptionally hard: the most thinking the model can give.',
}
const EFFORT_QUESTION = 'How much reasoning effort does working this ticket need?'

const FULLY_SPECIFIED_QUESTION = 'The ticket says exactly what to change.'

/** The description is cut to this many characters, to stay well inside Jev's 32k-token context. */
export const DESCRIPTION_LIMIT = 8000
/** How many similar past tickets (from `suggestAgent`) go into the state. */
export const SIMILAR_LIMIT = 5
/**
 * When the next likeliest effort is within this much probability of Jev's pick, the probability is spread over the
 * two, and the higher one wins (the lower one when Jev thinks the ticket is fully specified, see `spreadEffort`).
 */
export const TIE_MARGIN = 0.1

/** The state Jev routes `ticket` with: the ticket's content and how similar tickets on its board went. */
export function routingState(ticket: Ticket) {
  const tags = listTags(ticket.boardId)
  const description =
    ticket.description.length > DESCRIPTION_LIMIT
      ? `${ticket.description.slice(0, DESCRIPTION_LIMIT)}\n[cut]`
      : ticket.description
  const tagNames = ticket.tagIds.flatMap((id) => tags.find((tag) => tag.id === id)?.name ?? [])
  const steps = parseChecklist(ticket.description).length
  const similar = suggestAgent(ticket.boardId, {
    title: ticket.title,
    tag: ticket.tagIds,
    steps,
    estimate: ticket.estimate ?? undefined,
  })
    .options.flatMap(({ model, effort, similar }) =>
      similar.map((past) => ({
        title: past.title,
        similarity: past.similarity,
        model,
        effort,
        finished: past.finished,
      })),
    )
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, SIMILAR_LIMIT)
  return {
    title: ticket.title,
    description,
    tags: tagNames,
    epic: ticket.epicId ? getEpic(ticket.epicId).title : null,
    checklistSteps: steps,
    ...(ticket.estimate ? { planEstimate: ticket.estimate } : {}),
    similarPastTickets: similar,
  }
}

/** The questions Jev routes a ticket with, choosing among `models`. */
export function routingQuestions(models: readonly string[]): JevQuestion[] {
  return [
    {
      id: 'model',
      type: 'choice',
      question: MODEL_QUESTION,
      options: models.map((name) => ({ name, ...(MODEL_CRITERIA[name] ? { description: MODEL_CRITERIA[name] } : {}) })),
    },
    {
      id: 'effort',
      type: 'score',
      question: EFFORT_QUESTION,
      levels: AGENT_EFFORTS.map((name) => ({ name, description: EFFORT_LEVELS[name] })),
    },
    { id: 'fully_specified', type: 'noul', question: FULLY_SPECIFIED_QUESTION },
  ]
}

export interface TicketRoute {
  model: string
  effort: AgentEffort
  /** The lower of the model's and the effort's confidence, from 0 to 1. */
  confidence: number
  probabilities: {
    model: Record<string, number>
    effort: Record<string, number>
    /** How likely the ticket says exactly what to change, from 0 to 1. */
    fullySpecified: number
  }
}

const answer = <T extends JevAnswer['type']>(answers: JevAnswer[], id: string, type: T) =>
  answers.find((entry) => entry.id === id && entry.type === type) as Extract<JevAnswer, { type: T }> | undefined

/**
 * Asks Jev which model (of `models`, by default every model alias) and effort to work `ticket` at. Null when Jev
 * can't be asked or its answers don't fit the questions, so the caller falls back to another source. `onUsage` gets
 * the tokens the request used whenever Jev answered, fitting answers or not.
 */
export async function routeTicket(
  ticket: Ticket,
  { models = AGENT_MODELS, onUsage }: { models?: readonly string[]; onUsage?: (usage: JevUsage) => void } = {},
): Promise<TicketRoute | null> {
  if (!models.length) return null
  const result = await systemOne(routingState(ticket), routingQuestions(models))
  if (!result) return null
  onUsage?.(result.usage)
  const model = answer(result.answers, 'model', 'choice')
  const effort = answer(result.answers, 'effort', 'score')
  const fullySpecified = answer(result.answers, 'fully_specified', 'noul')?.probability ?? 0
  if (!model || !models.includes(model.choice) || !effort) return null
  const top = AGENT_EFFORTS.indexOf(effort.score as AgentEffort)
  if (top < 0) return null
  return {
    model: model.choice,
    effort: AGENT_EFFORTS[spreadEffort(top, effort.probabilities, fullySpecified)],
    confidence: Math.min(model.confidence, effort.confidence),
    probabilities: { model: model.probabilities, effort: effort.probabilities, fullySpecified },
  }
}

/**
 * The effort level to route with when Jev's Score picked level `top`: when its probability is spread over two efforts
 * (the next likeliest one is within `TIE_MARGIN` of it), the higher of the two, or the lower one when Jev thinks the
 * ticket is fully specified (`fullySpecified` above one half).
 */
function spreadEffort(top: number, probabilities: Record<string, number>, fullySpecified: number) {
  const chance = (level: number) => probabilities[AGENT_EFFORTS[level]] ?? 0
  const next = AGENT_EFFORTS.map((_, level) => level)
    .filter((level) => level !== top)
    .sort((a, b) => chance(b) - chance(a))[0]
  if (next === undefined || chance(top) - chance(next) > TIE_MARGIN) return top
  return fullySpecified > 0.5 ? Math.min(top, next) : Math.max(top, next)
}

/** Models from cheapest to dearest, for boards whose routing may only lower the setting. */
const MODEL_COST = ['haiku', 'sonnet', 'opus', 'fable']

/** Where a model stands in `MODEL_COST`, from its alias or a full name such as claude-opus-5-5; null when unknown. */
const modelRank = (model: string) => {
  const rank = MODEL_COST.findIndex((alias) => model.toLowerCase().includes(alias))
  return rank < 0 ? null : rank
}

type Setting = { model: string; effort: AgentEffort }

/**
 * `pick` held to no dearer than `limit`, its model and effort each. A model that can't be ranked against the limit's
 * (a name that isn't one of Claude's) gives way to the limit's.
 */
export function capSetting(pick: Setting, limit: Setting): Setting {
  const rank = modelRank(pick.model)
  const limitRank = modelRank(limit.model)
  const cheaper = pick.model === limit.model || (rank !== null && limitRank !== null && rank <= limitRank)
  return {
    model: cheaper ? pick.model : limit.model,
    effort: AGENT_EFFORTS.indexOf(pick.effort) <= AGENT_EFFORTS.indexOf(limit.effort) ? pick.effort : limit.effort,
  }
}

/**
 * What Jev is told about the ticket that a person writes: its title, description (with every checklist step
 * unchecked, so checking steps off doesn't count as a change), tags and epic, and the models it may pick from. Jev's
 * pick is kept with it, and Jev isn't asked again while it stays the same.
 */
export function contentKey(ticket: Ticket, models: readonly string[]) {
  const description = ticket.description.replace(/^(\s*[-*+]\s+\[)[xX](\]\s)/gm, '$1 $2')
  return createHash('sha256')
    .update(JSON.stringify([ticket.title, description, [...ticket.tagIds].sort(), ticket.epicId, models]))
    .digest('hex')
}

/** `pick` raised to no cheaper than `floor`, its model and effort each: the opposite of `capSetting`. */
export function raiseSetting(pick: Setting, floor: Setting): Setting {
  const rank = modelRank(pick.model)
  const floorRank = modelRank(floor.model)
  const dearer = pick.model === floor.model || rank === null || floorRank === null || rank >= floorRank
  return {
    model: dearer ? pick.model : floor.model,
    effort: AGENT_EFFORTS.indexOf(pick.effort) >= AGENT_EFFORTS.indexOf(floor.effort) ? pick.effort : floor.effort,
  }
}

/**
 * The confidence Jev's pick needs before it is used when it drops below the board's default to `haiku` or to `low`
 * effort: halfway from the board's threshold to 1 (0.85 at the default 0.7), as the docs advise gating riskier
 * choices higher. Staying at or above the default needs only the threshold.
 */
export const riskyThreshold = (threshold: number) => threshold + (1 - threshold) / 2

/** Whether `pick` drops to `haiku` or to `low` effort where the board's default `fallback` doesn't. */
const risky = (pick: Setting, fallback: Setting) =>
  (modelRank(pick.model) === 0 && modelRank(fallback.model) !== 0) ||
  (pick.effort === 'low' && fallback.effort !== 'low')

/**
 * Picks the setting a ticket is worked at on a board that routes with Jev, in order: the ticket's own setting (the
 * board's default for the half it leaves out), Jev's pick at or above the board's threshold (or `riskyThreshold` when
 * it drops to `haiku` or `low`), the history suggestion when it is built on enough similar tickets, then the board's
 * default. Jev's and the history suggestion's picks must be among the board's models for Jev, and are held to the
 * board's default when Jev may only lower the setting. Whichever of them routes, the ticket never goes below the
 * setting its last run worked at (`lastRunSetting`): a run that failed or came back with changes requested isn't
 * followed by a cheaper one.
 */
export function pickRoute(ticket: Ticket, board: BoardSummary, jev: RoutingPick | null): RoutedSetting {
  const fallback = boardDefault(board.id)
  if (ticket.agentModel !== null || ticket.agentEffort !== null) {
    const model = ticket.agentModel ?? fallback.model
    return { model, effort: ticket.agentEffort ?? fallback.effort, source: 'ticket', confidence: null }
  }
  const models: readonly string[] = board.jevModels ?? AGENT_MODELS
  const allowed = (pick: Setting) => models.includes(pick.model)
  const held = ({ model, effort }: Setting) =>
    board.jevOnlyLower ? capSetting({ model, effort }, fallback) : { model, effort }
  const last = lastRunSetting(ticket)
  const floored = (pick: Setting) => (last ? raiseSetting(pick, last) : pick)
  const threshold = board.jevThreshold ?? JEV_DEFAULTS.threshold
  if (jev && allowed(jev)) {
    const pick = held(jev)
    const needed = risky(pick, fallback) ? riskyThreshold(threshold) : threshold
    if ((jev.confidence ?? 0) >= needed) return { ...floored(pick), source: 'jev', confidence: jev.confidence }
  }
  const history = historyPick(ticket)
  if (history && allowed(history)) return { ...floored(held(history)), source: 'history', confidence: null }
  return { ...floored(fallback), source: 'default', confidence: null }
}

/**
 * Routes a ticket and records it (see `saveRoute`). On a board that routes with Jev, Jev is asked first, in either
 * mode (but in `on` only for tickets without their own setting), unless it already picked for the ticket as it is now
 * (see `contentKey`): a failed request is never kept, so the next one asks again. Returns the setting to work the
 * ticket at when the board's Jev mode is `on` (see `pickRoute`), else null: in dry run Jev's pick is only recorded, so
 * the board can see how Jev would have done. Never throws: a claim doesn't fail over its routing.
 */
export async function routeClaim(ticket: Ticket): Promise<RoutedSetting | null> {
  try {
    const board = getBoard(ticket.boardId)
    const models = board.jevModels ?? AGENT_MODELS
    const key = contentKey(ticket, models)
    const on = board.jevEnabled && board.jevMode === 'on'
    const own = ticket.agentModel !== null || ticket.agentEffort !== null
    let usage: JevUsage | null = null
    let jev: RoutingPick | null = null
    // Once Jev's picks are used, a ticket with its own setting isn't sent to Jev: that setting wins anyway.
    if (board.jevEnabled && typesafeKey() && !(on && own)) {
      jev = cachedJevPick(ticket.id, key) ?? (await routeTicket(ticket, { models, onUsage: (used) => (usage = used) }))
    }
    const routed = on ? pickRoute(ticket, board, jev) : null
    transaction(() => saveRoute(ticket.id, jev, usage, { routed, contentKey: key }))
    return routed
  } catch (error) {
    console.warn(`Routing ticket ${ticket.id}: ${(error as Error).message}`)
    return null
  }
}

/**
 * The setting to work an already claimed ticket at, for runs on feedback (`GET /tickets/:id/route`): as `routeClaim`,
 * but only on a board whose Jev mode is `on`, so it asks Jev only when the ticket changed since Jev last picked. Null
 * on other boards, without recording anything.
 */
export async function routeRun(ticket: Ticket): Promise<RoutedSetting | null> {
  const board = getBoard(ticket.boardId)
  return board.jevEnabled && board.jevMode === 'on' ? routeClaim(ticket) : null
}

/**
 * Asks Jev on demand which model and effort a ticket as written in the form needs (`POST /boards/:id/jev-suggestion`),
 * choosing among the board's models. Nothing is recorded. Null when Jev can't be asked or its answers don't fit.
 */
export async function suggestWithJev(
  boardId: string,
  draft: { title: string; description: string; tagIds: string[]; epicId: string | null },
): Promise<TicketRoute | null> {
  const board = getBoard(boardId)
  const tagIds = listTags(boardId).flatMap((tag) => (draft.tagIds.includes(tag.id) ? tag.id : []))
  const ticket = { ...draft, boardId, tagIds, estimate: null } as Ticket
  return routeTicket(ticket, { models: board.jevModels ?? AGENT_MODELS })
}
