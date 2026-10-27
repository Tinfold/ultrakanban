import { SparklesIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AGENT_DEFAULTS, type AgentEffort, type JevSuggestion } from '@shared/domain'
import type { JevSuggestionInput } from '@shared/schemas'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSetup } from '@/hooks/queries'
import { api } from '@/lib/api'
import { formatModel } from '@/lib/format'
import { useBoardContext } from '../board/board-context'

interface JevSuggestionButtonProps {
  title: string
  description: string
  tagIds: string[]
  epicId: string | null
  agentModel: string | null
  agentEffort: AgentEffort | null
  onApply: (model: string, effort: AgentEffort) => void
}

/** Jev is a paid call, so wait this long after the input stops changing before asking by itself. */
const ASK_DELAY_MS = 3000

/** What Jev already answered, by board and input, so re-rendering or reopening a ticket doesn't ask again. */
const answered = new Map<string, JevSuggestion>()

/** Asks Jev about `request` (a `JevSuggestionInput` as JSON) and keeps its answer under `key`. */
async function askJev(boardId: string, request: string, key: string) {
  const result = await api.jevSuggestion(boardId, JSON.parse(request) as JevSuggestionInput)
  answered.set(key, result)
  return result
}

const percent = (probability: number) => `${Math.round(probability * 100)}%`

/** The probabilities as `Sonnet 70% · Opus 20%`, likeliest first. */
const odds = (probabilities: Record<string, number>, label: (name: string) => string) =>
  Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([name, probability]) => `${label(name)} ${percent(probability)}`)
    .join(' · ')

/**
 * Asks Jev which model and effort the ticket as written needs, on demand, and offers its pick with how likely each
 * choice is. Hidden unless the board routes with Jev and a TypeSafe key is set, since Jev is not asked otherwise.
 */
export function JevSuggestionButton({
  title,
  description,
  tagIds,
  epicId,
  agentModel,
  agentEffort,
  onApply,
}: JevSuggestionButtonProps) {
  const { detail } = useBoardContext()
  const hasKey = !!useSetup().data?.typesafe.source && detail.board.jevEnabled
  const boardId = detail.board.id
  // What Jev is asked about, as JSON so the effect below only sees it change when its content does.
  const request = JSON.stringify({ title, description, tagIds, epicId } satisfies JevSuggestionInput)
  const key = `${boardId} ${request}`
  const [state, setState] = useState<{
    key: string
    asking: boolean
    suggestion: JevSuggestion | null
    failed: boolean
  }>({ key, asking: false, suggestion: null, failed: false })
  const canAsk = hasKey && !!title.trim()

  useEffect(() => {
    if (!canAsk || answered.has(key)) return
    let current = true
    const timer = setTimeout(() => {
      setState({ key, asking: true, suggestion: null, failed: false })
      askJev(boardId, request, key)
        .then((result) => current && setState({ key, asking: false, suggestion: result, failed: false }))
        .catch(() => current && setState({ key, asking: false, suggestion: null, failed: true }))
    }, ASK_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [canAsk, key, boardId, request])

  if (!hasKey) return null
  // Jev's answer for the ticket as it is now when it was asked about before; else the last ask's, until asking again.
  const known = state.key === key ? undefined : answered.get(key)
  const { asking, suggestion, failed } = known ? { asking: false, suggestion: known, failed: false } : state

  const ask = async () => {
    setState({ key, asking: true, suggestion: null, failed: false })
    try {
      setState({ key, asking: false, suggestion: await askJev(boardId, request, key), failed: false })
    } catch {
      setState({ key, asking: false, suggestion: null, failed: true })
    }
  }

  const uses =
    !!suggestion &&
    (agentModel ?? detail.board.agentModel ?? AGENT_DEFAULTS.model) === suggestion.model &&
    (agentEffort ?? detail.board.agentEffort ?? AGENT_DEFAULTS.effort) === suggestion.effort

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={asking || !title.trim()}
          onClick={ask}
        >
          <SparklesIcon />
          {asking ? 'Asking Jev…' : 'Suggest with Jev'}
        </Button>
        {suggestion && !uses && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => onApply(suggestion.model, suggestion.effort)}
              >
                <SparklesIcon />
                Jev: {formatModel(suggestion.model)} · {suggestion.effort}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="flex-col items-start tabular-nums">
              <p className="max-w-80">Confidence {suggestion.confidence.toFixed(2)}. Click to use it.</p>
              <p className="max-w-80">Model: {odds(suggestion.probabilities.model, formatModel)}</p>
              <p className="max-w-80">Effort: {odds(suggestion.probabilities.effort, (n) => n)}</p>
              <p className="max-w-80">Fully specified: {percent(suggestion.probabilities.fullySpecified)}</p>
            </TooltipContent>
          </Tooltip>
        )}
        {failed && <span className="text-xs text-destructive">Jev could not be asked.</span>}
      </div>
    </div>
  )
}
