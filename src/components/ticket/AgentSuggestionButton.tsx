import { SparklesIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AGENT_DEFAULTS, type AgentEffort, type AgentSettingStats } from '@shared/domain'
import { parseChecklist } from '@shared/checklist'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { formatCost, formatModel, formatTokens } from '@/lib/format'
import { useBoardContext } from '../board/board-context'

interface AgentSuggestionButtonProps {
  title: string
  description: string
  tagIds: string[]
  agentModel: string | null
  agentEffort: AgentEffort | null
  onApply: (model: string, effort: AgentEffort) => void
}

const cost = (stats: Pick<AgentSettingStats, 'costUsd' | 'tokens'>) =>
  stats.costUsd !== null ? formatCost(stats.costUsd) : `${formatTokens(stats.tokens)} tokens`

/**
 * Suggests a model and effort for a new ticket from how similar tickets on the board went, as it is being written.
 * Shown only when the suggestion differs from what the ticket would run at.
 */
export function AgentSuggestionButton({
  title,
  description,
  tagIds,
  agentModel,
  agentEffort,
  onApply,
}: AgentSuggestionButtonProps) {
  const { detail } = useBoardContext()
  const boardId = detail.board.id
  const [suggestion, setSuggestion] = useState<AgentSettingStats | null>(null)
  const steps = parseChecklist(description).length
  const tagKey = tagIds.join(',')
  // Nothing to compare with before it has a title or tags.
  const described = !!title.trim() || !!tagKey

  useEffect(() => {
    if (!described) return
    let current = true
    const timer = setTimeout(() => {
      api
        .agentSuggestion(boardId, { title, tags: tagKey ? tagKey.split(',') : [], steps })
        .then((result) => current && setSuggestion(result.suggestion))
        .catch(() => current && setSuggestion(null))
    }, 400)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [boardId, described, title, tagKey, steps])

  if (!described || !suggestion) return null
  const model = agentModel ?? detail.board.agentModel ?? AGENT_DEFAULTS.model
  const effort = agentEffort ?? detail.board.agentEffort ?? AGENT_DEFAULTS.effort
  if (suggestion.model === model && suggestion.effort === effort) return null

  return (
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
          Suggested: {formatModel(suggestion.model)} · {suggestion.effort}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start">
        <p className="max-w-80">
          {suggestion.finished} of {suggestion.tickets} similar {suggestion.tickets === 1 ? 'ticket' : 'tickets'} done
          at this setting, {cost(suggestion)} each on average. Click to use it.
        </p>
        <ul className="max-w-80">
          {suggestion.similar.map((ticket) => (
            <li key={ticket.id} className="truncate">
              #{ticket.number} {ticket.title} ({ticket.finished ? 'done' : 'not done'}, {cost(ticket)})
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}
