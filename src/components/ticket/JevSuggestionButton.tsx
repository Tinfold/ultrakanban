import { SparklesIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AGENT_DEFAULTS, type AgentEffort, type JevSuggestion } from '@shared/domain'
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
  const [state, setState] = useState<{ asking: boolean; suggestion: JevSuggestion | null; failed: boolean }>({
    asking: false,
    suggestion: null,
    failed: false,
  })
  const canAsk = hasKey && !!title.trim()
  const key = JSON.stringify([boardId, title, description, tagIds, epicId])

  useEffect(() => {
    if (!canAsk) return
    const known = answered.get(key)
    if (known) {
      setState({ asking: false, suggestion: known, failed: false })
      return
    }
    let current = true
    const timer = setTimeout(() => {
      setState({ asking: true, suggestion: null, failed: false })
      api
        .jevSuggestion(boardId, { title, description, tagIds, epicId })
        .then((result) => {
          answered.set(key, result)
          if (current) setState({ asking: false, suggestion: result, failed: false })
        })
        .catch(() => current && setState({ asking: false, suggestion: null, failed: true }))
    }, ASK_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [canAsk, key])

  if (!hasKey) return null
  const { asking, suggestion, failed } = state

  const ask = async () => {
    setState({ asking: true, suggestion: null, failed: false })
    try {
      const result = await api.jevSuggestion(boardId, { title, description, tagIds, epicId })
      answered.set(key, result)
      setState({ asking: false, suggestion: result, failed: false })
    } catch {
      setState({ asking: false, suggestion: null, failed: true })
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
