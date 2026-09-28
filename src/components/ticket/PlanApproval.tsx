import { ClipboardCheckIcon } from 'lucide-react'
import { useState } from 'react'
import type { Ticket } from '@shared/domain'
import { Markdown } from '@/components/common/Markdown'
import { Button } from '@/components/ui/button'
import { useTicketActivity } from '@/hooks/queries'
import { useBoardContext } from '../board/board-context'

/** The plan a ticket's agent waits on approval for, with the button that approves it. Nothing otherwise. */
export function PlanApproval({ ticket }: { ticket: Ticket }) {
  const { actions } = useBoardContext()
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
      {plan?.type === 'plan' && <Markdown className="text-sm">{plan.data.body}</Markdown>}
      <p className="text-xs text-muted-foreground">
        To change the plan, comment on the ticket: the agent answers and posts a new one. To drop it, move the ticket
        back to the backlog or cancel it.
      </p>
    </section>
  )
}
