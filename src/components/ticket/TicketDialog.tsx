import { CheckIcon, ChevronRightIcon, LinkIcon, MoreHorizontalIcon, Trash2Icon, XIcon } from 'lucide-react'
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
import { useDebouncedCallback } from '@/hooks/use-debounced-callback'
import { formatDateTime, formatRelative, ticketRef } from '@/lib/format'
import { ticketHref } from '@/lib/overview'
import { useBoardContext } from '../board/board-context'
import { ActivityFeed } from './ActivityFeed'
import { AttachmentsSection } from './attachments'
import { DescriptionEditor } from './DescriptionEditor'
import { PlanApproval } from './PlanApproval'
import { SubticketsSection } from './SubticketsSection'
import { TicketProperties } from './TicketProperties'
import { TitleInput } from './TitleInput'
import { useAttachmentUploads } from './use-attachment-uploads'

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
  const saveDescription = useDebouncedCallback(
    (description: string) => actions.updateTicket(ticket.id, { description }),
    800,
  )

  const copy = async (text: string, message: string) => {
    await navigator.clipboard.writeText(text)
    toast.success(message)
  }

  const copyLink = async () => {
    await copy(window.location.href, 'Link copied')
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
        <div className="ml-auto flex items-center gap-0.5">
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
            <DescriptionEditor
              value={ticket.description}
              onChange={saveDescription.schedule}
              onBlur={saveDescription.flush}
              className="-mx-3"
            />
            <SubticketsSection ticket={ticket} />
            <AttachmentsSection ticketId={ticket.id} uploads={uploads} />
            <ActivityFeed ticketId={ticket.id} pullRequest={ticket.pullRequest} />
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
