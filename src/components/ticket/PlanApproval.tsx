import { ClipboardCheckIcon } from 'lucide-react'
import { useState } from 'react'
import { AGENT_DEFAULTS, type Ticket } from '@shared/domain'
import { JevBadge } from '@/components/common/JevBadge'
import { Markdown } from '@/components/common/Markdown'
import { Button } from '@/components/ui/button'
import { useTicketActivity } from '@/hooks/queries'
import { formatModel } from '@/lib/format'
import { useBoardContext } from '../board/board-context'
import { EffortPicker, ModelPicker } from './pickers'

/** The plan a ticket's agent waits on approval for, with the button that approves it. Nothing otherwise. */
export function PlanApproval({ ticket }: { ticket: Ticket }) {
  const { actions, detail } = useBoardContext()
  const { data: activity = [] } = useTicketActivity(ticket.id)
  const [approving, setApproving] = useState(false)
  if (ticket.approval !== 'pending') return null
  const plan = activity.findLast((entry) => entry.type === 'plan')

  const approve = async () => {
    setApproving(true)
    await actions.approvePlan(ticket.id)
    setApproving(false)
  }

  return (
    <section
      aria-labelledby="plan-approval-heading"
      className="grid gap-3 rounded-lg border border-violet-500/40 bg-violet-500/5 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ClipboardCheckIcon className="size-4 text-violet-600 dark:text-violet-400" />
        <h3 id="plan-approval-heading" className="min-w-0 flex-1 text-sm">
          <span className="font-medium">{ticket.assignee ?? 'The agent'}</span> estimated this at size{' '}
          <span className="font-medium">{ticket.estimate}</span> and waits for your approval before working it.
        </h3>
        <Button size="sm" onClick={approve} disabled={approving}>
          Approve plan
        </Button>
      </div>
      {ticket.jevPick && (
        <p className="flex flex-wrap items-center gap-1.5 text-sm">
          Will run at <span className="font-medium">{formatModel(ticket.jevPick.model)}</span> ·{' '}
          <span className="font-medium">{ticket.jevPick.effort}</span>
          <JevBadge pick={ticket.jevPick} />
          <span className="text-xs text-muted-foreground">
            Jev’s pick. Set the ticket’s agent model and effort to override it before approving.
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Runs with</span>
        <ModelPicker
          value={ticket.agentModel}
          onChange={(agentModel) => actions.updateTicket(ticket.id, { agentModel })}
        >
          <Button variant="outline" size="sm">
            {formatModel(ticket.agentModel ?? detail.board.agentModel ?? AGENT_DEFAULTS.model)}
          </Button>
        </ModelPicker>
        <EffortPicker
          value={ticket.agentEffort}
          onChange={(agentEffort) => actions.updateTicket(ticket.id, { agentEffort })}
        >
          <Button variant="outline" size="sm">
            {ticket.agentEffort ?? detail.board.agentEffort ?? AGENT_DEFAULTS.effort}
          </Button>
        </EffortPicker>
      </div>
      {plan?.type === 'plan' && <Markdown className="text-sm">{plan.data.body}</Markdown>}
      <p className="text-xs text-muted-foreground">
        To change the plan, comment on the ticket: the agent answers and posts a new one. To drop it, move the ticket
        back to the backlog or cancel it.
      </p>
    </section>
  )
}
