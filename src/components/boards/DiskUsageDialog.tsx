import { useQueryClient } from '@tanstack/react-query'
import { Loader2Icon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { useSearchParams } from 'wouter'
import { type AttachmentBytes, type BoardDiskBreakdown, CANCELLED_COLUMN } from '@shared/domain'
import { useBoardContext } from '@/components/board/board-context'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { queryKeys, useDiskUsage } from '@/hooks/queries'
import { api, errorMessage } from '@/lib/api'
import { formatBytes, formatRelative, ticketRef } from '@/lib/format'

/** The ages the attachments cleanup offers, in days; 0 deletes them whatever their age. */
const AGES = [0, 7, 30, 90] as const

const files = ({ count }: AttachmentBytes) => `${count} file${count === 1 ? '' : 's'}`

function Row({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="flex items-baseline gap-2 py-1 text-sm">
      <span>{label}</span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      <span className="ml-auto tabular-nums">{formatBytes(value)}</span>
    </div>
  )
}

function Section({ title, total, children }: { title: string; total?: number; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      <h3 className="flex items-baseline border-b pb-1 text-sm font-medium">
        {title}
        {total !== undefined && <span className="ml-auto tabular-nums">{formatBytes(total)}</span>}
      </h3>
      {children}
    </section>
  )
}

export function DiskUsageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DiskUsage onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

/** Mounted with the dialog's content, so every opening loads fresh numbers. */
function DiskUsage({ onClose }: { onClose: () => void }) {
  const { detail } = useBoardContext()
  const usage = useDiskUsage(detail.board.id)

  return (
    <>
      <DialogHeader>
        <DialogTitle>Disk usage</DialogTitle>
        <DialogDescription>What “{detail.board.name}” takes on disk, and ways to free some.</DialogDescription>
      </DialogHeader>
      {usage.isPending ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Adding it up…
        </p>
      ) : usage.isError ? (
        <p className="py-4 text-sm text-destructive">{errorMessage(usage.error)}</p>
      ) : (
        <div className="grid gap-6">
          <Attachments usage={usage.data} onClose={onClose} />
          <AgentFolder usage={usage.data} />
        </div>
      )}
    </>
  )
}

function Attachments({ usage, onClose }: { usage: BoardDiskBreakdown; onClose: () => void }) {
  const { detail, columnsById } = useBoardContext()
  const boardId = detail.board.id
  const queryClient = useQueryClient()
  const [, setSearchParams] = useSearchParams()
  const [age, setAge] = useState<(typeof AGES)[number]>(0)
  const [confirming, setConfirming] = useState(false)
  const { images, videos, finished, tickets } = usage.attachments
  const done =
    (detail.board.doneColumnId && columnsById.get(detail.board.doneColumnId)?.name) || detail.columns.at(-1)?.name
  const cancelled = detail.columns.find((column) => column.name.toLowerCase() === CANCELLED_COLUMN)?.name
  const finishedColumns = [done, cancelled].filter(Boolean).map((name) => `“${name}”`)

  const openTicket = (ticketId: string) => {
    onClose()
    setSearchParams({ ticket: ticketId })
  }

  const cleanUp = async () => {
    try {
      const deleted = await api.cleanUpAttachments(boardId, age || null)
      toast.success(
        deleted.count
          ? `Deleted ${files(deleted)}, freeing ${formatBytes(deleted.bytes)}`
          : 'No attachments matched: nothing deleted',
      )
    } catch (error) {
      toast.error(errorMessage(error))
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.diskUsage(boardId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.allAttachments })
    void queryClient.invalidateQueries({ queryKey: queryKeys.allOverviews })
  }

  return (
    <Section title="Attachments" total={images.bytes + videos.bytes}>
      <Row label="Screenshots" detail={files(images)} value={images.bytes} />
      <Row label="Screen recordings" detail={files(videos)} value={videos.bytes} />
      <Row label="On finished tickets" detail={files(finished)} value={finished.bytes} />

      {tickets.length > 0 && (
        <>
          <h4 className="mt-2 text-xs font-medium text-muted-foreground">Largest</h4>
          <ul className="grid">
            {tickets.map((ticket) => (
              <li key={ticket.ticketId}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
                  onClick={() => openTicket(ticket.ticketId)}
                >
                  <span className="font-mono text-[11px] text-muted-foreground">{ticketRef(ticket.number)}</span>
                  <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
                  {ticket.finished && <span className="text-xs text-muted-foreground">finished</span>}
                  <span className="tabular-nums">{formatBytes(ticket.bytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select value={String(age)} onValueChange={(value) => setAge(Number(value) as typeof age)}>
          <SelectTrigger aria-label="Uploaded" size="sm" className="mr-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGES.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {days ? `Uploaded over ${days} days ago` : 'Any age'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="destructive" size="sm" disabled={!finished.count} onClick={() => setConfirming(true)}>
          Delete finished tickets’ attachments
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete the attachments of finished tickets?"
        description={`The screenshots and recordings of the tickets in ${finishedColumns.join(' or ')}${age ? ` uploaded more than ${age} days ago` : ''} will be permanently deleted. Their tickets, comments and pull requests stay.`}
        confirmLabel="Delete attachments"
        onConfirm={() => void cleanUp()}
      />
    </Section>
  )
}

function AgentFolder({ usage }: { usage: BoardDiskBreakdown }) {
  const { detail } = useBoardContext()
  const { agent } = usage
  const requestedAt = detail.board.agentCleanupRequestedAt
  const [confirming, setConfirming] = useState(false)

  const clear = async () => {
    try {
      await api.requestAgentCleanup(detail.board.id)
      toast.success('Asked the agent to clear its build output')
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  if (!agent) {
    return (
      <Section title="Agent folder">
        <p className="text-sm text-muted-foreground">
          Not measured: the agent supervisor measures the folder of each board’s agent where the agents run.
        </p>
      </Section>
    )
  }
  return (
    <Section title="Agent folder" total={agent.repo + agent.worktrees + agent.state}>
      <Row label="Clone" value={agent.repo} />
      <Row label="Worktrees" detail="for parallel runs" value={agent.worktrees} />
      <Row label="Agent state and scratch files" value={agent.state} />
      <p className="text-xs text-muted-foreground">Measured {formatRelative(agent.measuredAt)}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-muted-foreground">
          {requestedAt ? `Clearing asked for ${formatRelative(requestedAt)}` : 'Most of it is usually build output.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          Clear build output
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Clear the agent’s build output?"
        description="Each of the board’s agent loops removes the ignored files of its checkout (build output such as node_modules/ or target/) right away when idle, otherwise once its run ends. Runs after it build from scratch. Work and branches are kept. The new size shows once the agents’ disk is measured again."
        confirmLabel="Clear build output"
        onConfirm={() => void clear()}
      />
    </Section>
  )
}
