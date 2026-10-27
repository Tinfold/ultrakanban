import {
  CheckIcon,
  ChevronRightIcon,
  LinkIcon,
  MoreHorizontalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link } from 'wouter'
import type { Ticket } from '@shared/domain'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ColorDot } from '@/components/common/TagChip'
import { WaitingBadge } from '@/components/common/WaitingBadge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { copyText } from '@/lib/clipboard'
import { formatDateTime, formatRelative, ticketRef } from '@/lib/format'
import { ticketHref } from '@/lib/overview'
import { useBoardContext } from '../board/board-context'
import { RunStatus } from '../board/RunStatus'
import { ActivityFeed } from './ActivityFeed'
import { AttachmentsSection } from './attachments'
import { DescriptionEditor } from './DescriptionEditor'
import { PlanApproval } from './PlanApproval'
import { SubticketsSection } from './SubticketsSection'
import { TicketProperties } from './TicketProperties'
import { TitleInput } from './TitleInput'
import { useAttachmentUploads } from './use-attachment-uploads'
import { useDescriptionSaver } from './use-description-saver'

interface TicketDialogProps {
  ticketId: string | null
  onClose: () => void
}

export function TicketDialog({ ticketId, onClose }: TicketDialogProps) {
  const { ticketsById } = useBoardContext()
  const ticket = ticketId ? ticketsById.get(ticketId) : undefined

  // The ticket was deleted (possibly by someone else) or the link is stale.
  useEffect(() => {
    if (ticketId && !ticket) onClose()
  }, [ticketId, ticket, onClose])

  return (
    <Dialog open={!!ticket} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-dvh max-h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[min(92dvh,56rem)] sm:max-w-[min(64rem,calc(100%-3rem))] sm:rounded-xl"
      >
        {ticket && <TicketDetail key={ticket.id} ticket={ticket} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function TicketDetail({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { actions, columnsById, ticketsById } = useBoardContext()
  const parent = ticket.parentId ? ticketsById.get(ticket.parentId) : undefined
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [copied, setCopied] = useState(false)
  const column = columnsById.get(ticket.columnId)
  const uploads = useAttachmentUploads(ticket.id)
  const description = useDescriptionSaver(ticket, actions)

  const copy = async (text: string, message: string) => {
    try {
      await copyText(text)
    } catch {
      toast.error("Couldn't copy to the clipboard")
      return false
    }
    toast.success(message)
    return true
  }

  const copyLink = async () => {
    if (!(await copy(window.location.href, 'Link copied'))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b pr-2 pl-4 text-sm">
        {parent && (
          <>
            <Link
              href={ticketHref(parent)}
              className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
              title={`Sub-ticket of ${ticketRef(parent.number)}: ${parent.title}`}
            >
              {ticketRef(parent.number)}
            </Link>
            <ChevronRightIcon className="size-3.5 text-muted-foreground/60" />
          </>
        )}
        <span className="font-mono text-xs text-muted-foreground">{ticketRef(ticket.number)}</span>
        <ChevronRightIcon className="size-3.5 text-muted-foreground/60" />
        {column && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <ColorDot color={column.color} />
            <span className="truncate">{column.name}</span>
          </span>
        )}
        <WaitingBadge ticket={ticket} className="ml-2 text-xs [&_svg]:size-3.5" />
        {ticket.run && <RunStatus ticket={ticket} className="mt-0 ml-2 text-xs" />}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label="Copy link" onClick={copyLink}>
            {copied ? <CheckIcon /> : <LinkIcon />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Ticket actions">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => copy(ticket.id, 'Ticket ID copied')}>Copy ticket ID</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => copy(ticket.description, 'Markdown copied')}>
                Copy as markdown
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
                <Trash2Icon />
                Delete ticket
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close">
              <XIcon />
            </Button>
          </DialogClose>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onPaste={(event) => {
          const files = [...event.clipboardData.files]
          if (!files.length) return
          event.preventDefault()
          void uploads.upload(files)
        }}
      >
        <div className="grid gap-x-8 gap-y-5 px-4 py-5 sm:px-8 sm:py-7 md:grid-cols-[minmax(0,1fr)_16rem] md:grid-rows-[auto_1fr]">
          <DialogTitle asChild>
            <TitleInput value={ticket.title} onCommit={(title) => actions.updateTicket(ticket.id, { title })} />
          </DialogTitle>
          <DialogDescription className="sr-only">Ticket details</DialogDescription>

          <aside className="md:sticky md:top-0 md:col-start-2 md:row-span-2 md:row-start-1 md:self-start">
            <TicketProperties ticket={ticket} />
            <p className="mt-4 border-t px-2 pt-3 text-xs leading-relaxed text-muted-foreground">
              Created <span title={formatDateTime(ticket.createdAt)}>{formatRelative(ticket.createdAt)}</span>
              <br />
              Updated <span title={formatDateTime(ticket.updatedAt)}>{formatRelative(ticket.updatedAt)}</span> · v
              {ticket.version}
            </p>
          </aside>

          <div className="grid min-w-0 content-start gap-8 md:col-start-1">
            <PlanApproval ticket={ticket} />
            <div className="grid gap-2">
              {description.conflict !== null && (
                <div
                  role="alert"
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200"
                >
                  <p className="flex items-start gap-2">
                    <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                    Someone changed this description while you were editing it, so your edit isn’t saved. Your text is
                    kept below.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                    <Button size="sm" variant="outline" onClick={description.copyConflict}>
                      Copy my text
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={description.loadLatest}
                      title={
                        description.copyFailed
                          ? 'Drops your text, which couldn’t be copied, and shows the description as it is now'
                          : 'Copies your text, then shows the description as it is now'
                      }
                    >
                      {description.copyFailed ? 'Load the latest anyway' : 'Load the latest'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={description.saveMine}>
                      Save mine anyway
                    </Button>
                  </div>
                </div>
              )}
              <DescriptionEditor
                key={description.editorKey}
                value={ticket.description}
                onChange={description.onChange}
                onBlur={description.onBlur}
                onSync={description.onSync}
                className="-mx-3"
              />
            </div>
            <SubticketsSection ticket={ticket} />
            <AttachmentsSection ticketId={ticket.id} uploads={uploads} />
            <ActivityFeed ticketId={ticket.id} pullRequest={ticket.pullRequest} run={ticket.run} />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete ${ticketRef(ticket.number)}?`}
        description="The ticket and its activity will be permanently deleted."
        confirmLabel="Delete ticket"
        onConfirm={() => {
          onClose()
          void actions.deleteTicket(ticket.id)
        }}
      />
    </>
  )
}
