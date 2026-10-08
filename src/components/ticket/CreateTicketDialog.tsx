import { CalendarIcon, CpuIcon, FileTextIcon, GaugeIcon, LayersIcon, TagIcon, UserRoundIcon } from 'lucide-react'
import { type FormEvent, useRef, useState } from 'react'
import { AGENT_DEFAULTS, type AgentEffort, isClaudeModel, type Priority, TICKET_TEMPLATES } from '@shared/domain'
import { EpicChip } from '@/components/common/EpicChip'
import { PriorityIcon } from '@/components/common/PriorityIcon'
import { ColorDot, TagChip } from '@/components/common/TagChip'
import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { formatDueDate } from '@/lib/format'
import { PRIORITY_LABELS } from '@/lib/priority'
import { useBoardContext } from '../board/board-context'
import { AgentSuggestionButton } from './AgentSuggestionButton'
import { DescriptionEditor } from './DescriptionEditor'
import {
  AssigneePicker,
  ColumnPicker,
  DueDatePicker,
  EffortPicker,
  EpicPicker,
  ModelPicker,
  PriorityPicker,
  TagPicker,
  TemplatePicker,
} from './pickers'

interface CreateTicketDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (ticketId: string) => void
  /** The epic the new ticket starts in, e.g. the one the board is filtered to. */
  epicId?: string | null
}

export function CreateTicketDialog({ open, onOpenChange, onCreated, epicId = null }: CreateTicketDialogProps) {
  const createdId = useRef<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 p-0 sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          // Open the new ticket only once this dialog is gone; returning focus first would dismiss it.
          if (!createdId.current) return
          event.preventDefault()
          onCreated(createdId.current)
          createdId.current = null
        }}
      >
        {open && (
          <CreateTicketForm
            initialEpicId={epicId}
            onDone={() => onOpenChange(false)}
            onCreated={(ticketId) => {
              createdId.current = ticketId
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface CreateTicketFormProps {
  initialEpicId: string | null
  onDone: () => void
  onCreated: (ticketId: string) => void
}

function CreateTicketForm({ initialEpicId, onDone, onCreated }: CreateTicketFormProps) {
  const { detail, actions, columnsById, tagsById, epicsById } = useBoardContext()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [columnId, setColumnId] = useState(detail.columns[0]?.id ?? '')
  const [priority, setPriority] = useState<Priority>('none')
  const [assignee, setAssignee] = useState<string | null>(null)
  const [dueDate, setDueDate] = useState<string | null>(null)
  const [tagIds, setTagIds] = useState<string[]>([])
  const [epicId, setEpicId] = useState<string | null>(initialEpicId)
  const [agentEffort, setAgentEffort] = useState<AgentEffort | null>(null)
  const [agentModel, setAgentModel] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const column = columnsById.get(columnId)
  const epic = epicId ? epicsById.get(epicId) : undefined

  const applyTemplate = async (template: (typeof TICKET_TEMPLATES)[number]) => {
    setDescription(template.description)
    setAgentEffort(template.agentEffort)
    // The templates' models are Claude's, which a board's agent on another model (through an endpoint) can't run.
    setAgentModel(isClaudeModel(detail.board.agentModel ?? AGENT_DEFAULTS.model) ? template.agentModel : null)
    const added: string[] = []
    for (const tagName of template.tags) {
      const existing = detail.tags.find((tag) => tag.name.toLowerCase() === tagName.toLowerCase())
      const tag = existing ?? (await actions.createTag({ name: tagName }))
      if (tag) added.push(tag.id)
    }
    setTagIds((current) => [...new Set([...current, ...added])])
  }

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!title.trim() || saving) return
    setSaving(true)
    const ticket = await actions.createTicket({
      title: title.trim(),
      description,
      column: columnId,
      priority,
      assignee,
      dueDate,
      tags: tagIds,
      epic: epicId,
      agentEffort,
      agentModel,
    })
    setSaving(false)
    if (ticket) onCreated(ticket.id)
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit()
      }}
    >
      <DialogHeader className="px-5 pt-5">
        <DialogTitle className="text-sm text-muted-foreground">New ticket</DialogTitle>
        <DialogDescription className="sr-only">Create a ticket on {detail.board.name}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2 px-5 py-3">
        <Input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Ticket title"
          aria-label="Title"
          className="h-auto border-0 bg-transparent! px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
        />
        <DescriptionEditor
          value={description}
          onChange={setDescription}
          className="-mx-3 max-h-[45dvh] overflow-y-auto"
        />
        <div className="flex flex-wrap gap-1.5 pt-1">
          <TemplatePicker onApply={applyTemplate}>
            <Button type="button" variant="outline" size="sm">
              <FileTextIcon />
              Template
            </Button>
          </TemplatePicker>
          <ColumnPicker value={columnId} onChange={setColumnId}>
            <Button type="button" variant="outline" size="sm">
              {column && <ColorDot color={column.color} />}
              {column?.name}
            </Button>
          </ColumnPicker>
          <PriorityPicker value={priority} onChange={setPriority}>
            <Button type="button" variant="outline" size="sm">
              <PriorityIcon priority={priority} />
              {PRIORITY_LABELS[priority]}
            </Button>
          </PriorityPicker>
          <AssigneePicker value={assignee} onChange={setAssignee}>
            <Button type="button" variant="outline" size="sm">
              {assignee ? <UserAvatar name={assignee} size="xs" /> : <UserRoundIcon />}
              {assignee ?? 'Assignee'}
            </Button>
          </AssigneePicker>
          <DueDatePicker value={dueDate} onChange={setDueDate}>
            <Button type="button" variant="outline" size="sm">
              <CalendarIcon />
              {dueDate ? formatDueDate(dueDate) : 'Due date'}
            </Button>
          </DueDatePicker>
          <TagPicker value={tagIds} onChange={setTagIds}>
            <Button type="button" variant="outline" size="sm" className="h-auto min-h-7 flex-wrap">
              {tagIds.length ? (
                tagIds.flatMap((tagId) => tagsById.get(tagId) ?? []).map((tag) => <TagChip key={tag.id} tag={tag} />)
              ) : (
                <>
                  <TagIcon />
                  Tags
                </>
              )}
            </Button>
          </TagPicker>
          <EpicPicker value={epicId} onChange={setEpicId}>
            <Button type="button" variant="outline" size="sm">
              {epic ? (
                <EpicChip epic={epic} className="-mx-1" />
              ) : (
                <>
                  <LayersIcon />
                  Epic
                </>
              )}
            </Button>
          </EpicPicker>
          {(detail.board.agentEnabled || agentEffort) && (
            <EffortPicker value={agentEffort} onChange={setAgentEffort}>
              <Button type="button" variant="outline" size="sm">
                <GaugeIcon />
                {agentEffort ?? `Board default (${detail.board.agentEffort ?? AGENT_DEFAULTS.effort})`}
              </Button>
            </EffortPicker>
          )}
          {(detail.board.agentEnabled || agentModel) && (
            <ModelPicker value={agentModel} onChange={setAgentModel}>
              <Button type="button" variant="outline" size="sm">
                <CpuIcon />
                {agentModel ?? `Board default (${detail.board.agentModel ?? AGENT_DEFAULTS.model})`}
              </Button>
            </ModelPicker>
          )}
          {detail.board.agentEnabled && (
            <AgentSuggestionButton
              title={title}
              description={description}
              tagIds={tagIds}
              agentModel={agentModel}
              agentEffort={agentEffort}
              onApply={(model, effort) => {
                setAgentModel(model)
                setAgentEffort(effort)
              }}
            />
          )}
        </div>
      </div>
      <DialogFooter className="m-0 items-center rounded-b-xl px-5 py-3">
        <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">
          <Kbd>⌘</Kbd> <Kbd>↵</Kbd> to create
        </span>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim() || saving}>
          Create ticket
        </Button>
      </DialogFooter>
    </form>
  )
}
