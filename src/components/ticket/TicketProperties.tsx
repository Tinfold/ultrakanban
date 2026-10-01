import { CalendarIcon, ContainerIcon, CpuIcon, GaugeIcon, TagIcon, UserRoundIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { AGENT_DEFAULTS, type Ticket } from '@shared/domain'
import { PriorityIcon } from '@/components/common/PriorityIcon'
import { ColorDot, TagChip } from '@/components/common/TagChip'
import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import { dockerLabel, dueState, formatCost, formatDueDate, formatTokens } from '@/lib/format'
import { PRIORITY_LABELS } from '@/lib/priority'
import { cn } from '@/lib/utils'
import { useBoardContext } from '../board/board-context'
import {
  AssigneePicker,
  ColumnPicker,
  DueDatePicker,
  DockerPicker,
  EffortPicker,
  ModelPicker,
  PriorityPicker,
  TagPicker,
} from './pickers'
import { PullRequestField } from './PullRequestField'

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="py-1.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

const triggerClass = 'h-auto min-h-7 w-full justify-start px-2 py-1 font-normal'

export function TicketProperties({ ticket }: { ticket: Ticket }) {
  const { actions, detail, moveTicket, columnsById, tagsById } = useBoardContext()
  const column = columnsById.get(ticket.columnId)
  const tags = ticket.tagIds.flatMap((tagId) => tagsById.get(tagId) ?? [])

  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5">
      <Property label="Status">
        <ColumnPicker value={ticket.columnId} onChange={(columnId) => moveTicket(ticket.id, columnId)}>
          <Button variant="ghost" size="sm" className={triggerClass}>
            {column && <ColorDot color={column.color} />}
            <span className="truncate">{column?.name}</span>
          </Button>
        </ColumnPicker>
      </Property>

      <Property label="Priority">
        <PriorityPicker value={ticket.priority} onChange={(priority) => actions.updateTicket(ticket.id, { priority })}>
          <Button variant="ghost" size="sm" className={triggerClass}>
            <PriorityIcon priority={ticket.priority} />
            {PRIORITY_LABELS[ticket.priority]}
          </Button>
        </PriorityPicker>
      </Property>

      <Property label="Assignee">
        <AssigneePicker value={ticket.assignee} onChange={(assignee) => actions.updateTicket(ticket.id, { assignee })}>
          <Button variant="ghost" size="sm" className={triggerClass}>
            {ticket.assignee ? (
              <>
                <UserAvatar name={ticket.assignee} size="xs" />
                <span className="truncate">{ticket.assignee}</span>
              </>
            ) : (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <UserRoundIcon />
                Unassigned
              </span>
            )}
          </Button>
        </AssigneePicker>
      </Property>

      <Property label="Due date">
        <DueDatePicker value={ticket.dueDate} onChange={(dueDate) => actions.updateTicket(ticket.id, { dueDate })}>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              triggerClass,
              !ticket.dueDate && 'text-muted-foreground',
              ticket.dueDate && dueState(ticket.dueDate) === 'overdue' && 'text-red-600 dark:text-red-400',
            )}
          >
            <CalendarIcon />
            {ticket.dueDate ? formatDueDate(ticket.dueDate) : 'No due date'}
          </Button>
        </DueDatePicker>
      </Property>

      {(detail.board.agentEnabled || ticket.agentEffort) && (
        <Property label="Agent effort">
          <EffortPicker
            value={ticket.agentEffort}
            onChange={(agentEffort) => actions.updateTicket(ticket.id, { agentEffort })}
          >
            <Button
              variant="ghost"
              size="sm"
              className={cn(triggerClass, !ticket.agentEffort && 'text-muted-foreground')}
            >
              <GaugeIcon />
              {ticket.agentEffort ?? `Board default (${detail.board.agentEffort ?? AGENT_DEFAULTS.effort})`}
            </Button>
          </EffortPicker>
        </Property>
      )}

      {(detail.board.agentEnabled || ticket.agentModel) && (
        <Property label="Agent model">
          <ModelPicker
            value={ticket.agentModel}
            onChange={(agentModel) => actions.updateTicket(ticket.id, { agentModel })}
          >
            <Button
              variant="ghost"
              size="sm"
              className={cn(triggerClass, !ticket.agentModel && 'text-muted-foreground')}
            >
              <CpuIcon />
              {ticket.agentModel ?? `Board default (${detail.board.agentModel ?? AGENT_DEFAULTS.model})`}
            </Button>
          </ModelPicker>
        </Property>
      )}

      {(detail.board.agentEnabled || ticket.agentDocker !== null) && (
        <Property label="Agent runs in">
          <DockerPicker
            value={ticket.agentDocker}
            onChange={(agentDocker) => actions.updateTicket(ticket.id, { agentDocker })}
          >
            <Button
              variant="ghost"
              size="sm"
              className={cn(triggerClass, ticket.agentDocker === null && 'text-muted-foreground')}
            >
              <ContainerIcon />
              {ticket.agentDocker === null
                ? `Board default (${dockerLabel(detail.board.agentDocker).toLowerCase()})`
                : dockerLabel(ticket.agentDocker)}
            </Button>
          </DockerPicker>
        </Property>
      )}

      <Property label="Pull request">
        <PullRequestField ticket={ticket} />
      </Property>

      {ticket.usage.runs > 0 && (
        <Property label="Usage">
          <p className="px-2 py-1.5 text-sm tabular-nums">
            {formatTokens(ticket.usage.tokens)} tokens
            {ticket.usage.costUsd !== null && <> · {formatCost(ticket.usage.costUsd)}</>}
            <span className="text-muted-foreground">
              {' '}
              over {ticket.usage.runs} {ticket.usage.runs === 1 ? 'run' : 'runs'}
            </span>
          </p>
        </Property>
      )}

      <Property label="Tags">
        <TagPicker value={ticket.tagIds} onChange={(tagIds) => actions.updateTicket(ticket.id, { tagIds })}>
          <Button variant="ghost" size="sm" className={cn(triggerClass, 'flex-wrap gap-1')}>
            {tags.length ? (
              tags.map((tag) => <TagChip key={tag.id} tag={tag} />)
            ) : (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <TagIcon />
                Add tags
              </span>
            )}
          </Button>
        </TagPicker>
      </Property>
    </dl>
  )
}
