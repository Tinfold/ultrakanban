import { AGENT_IDLE_MINUTES, type Column, type Ticket } from '@shared/domain'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { formatRelative, ticketRef } from '@/lib/format'
import { useBoardContext } from './board-context'

interface ReleaseIdleDialogProps {
  column: Column
  /** Where the idle tickets go, e.g. Todo. */
  target: Column
  tickets: Ticket[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Moves the tickets of a column that no agent is working on back to another column, unassigned. */
export function ReleaseIdleDialog({ column, target, tickets, open, onOpenChange }: ReleaseIdleDialogProps) {
  const { actions } = useBoardContext()
  const count = `${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Move idle tickets back to “${target.name}”?`}
      description={`No agent has worked on ${tickets.length === 1 ? 'this ticket' : 'these tickets'} in “${column.name}” for ${AGENT_IDLE_MINUTES} minutes. They will be unassigned, so an agent can claim them again.`}
      confirmLabel={`Move ${count}`}
      onConfirm={() => void actions.releaseIdleTickets(column.id, target.id)}
    >
      <ul className="grid max-h-64 gap-2 overflow-y-auto text-sm">
        {tickets.map((ticket) => (
          <li key={ticket.id} className="grid grid-cols-[auto_1fr] items-baseline gap-x-2">
            <span className="font-mono text-[11px] text-muted-foreground">{ticketRef(ticket.number)}</span>
            <span className="truncate">{ticket.title}</span>
            <span className="col-start-2 truncate text-xs text-muted-foreground">
              {ticket.assignee ?? 'Unassigned'} · updated {formatRelative(ticket.updatedAt)}
            </span>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  )
}
