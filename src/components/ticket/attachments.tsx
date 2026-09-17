import { CopyIcon, ExternalLinkIcon, PaperclipIcon, PlayIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { type DragEvent, useState } from 'react'
import { toast } from 'sonner'
import { type Attachment, ATTACHMENT_TYPES } from '@shared/domain'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTicketAttachments } from '@/hooks/queries'
import { formatBytes, pickFiles } from '@/lib/files'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useBoardContext } from '../board/board-context'
import type { AttachmentUploads } from './use-attachment-uploads'

export function AttachmentThumbnail({ attachment, className }: { attachment: Attachment; className?: string }) {
  const video = attachment.contentType.startsWith('video/')
  return (
    <span className={cn('relative block overflow-hidden rounded-lg border bg-muted', className)}>
      {video ? (
        <>
          <video src={attachment.url} preload="metadata" muted className="size-full object-cover" />
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-8 place-items-center rounded-full bg-black/60 text-white">
              <PlayIcon className="size-4 fill-current" />
            </span>
          </span>
        </>
      ) : (
        <img src={attachment.url} alt={attachment.filename} loading="lazy" className="size-full object-cover" />
      )}
    </span>
  )
}

interface AttachmentViewerProps {
  ticketId: string
  attachment: Attachment | null
  onClose: () => void
}

export function AttachmentViewer({ ticketId, attachment, onClose }: AttachmentViewerProps) {
  const { actions } = useBoardContext()
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const copyMarkdown = async (item: Attachment) => {
    await navigator.clipboard.writeText(`![${item.filename}](${item.url})`)
    toast.success('Markdown copied')
  }

  return (
    <Dialog open={!!attachment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[min(72rem,calc(100%-3rem))]">
        {attachment && (
          <>
            <div className="grid max-h-[75dvh] place-items-center bg-black/90">
              {attachment.contentType.startsWith('video/') ? (
                <video src={attachment.url} controls autoPlay className="max-h-[75dvh] w-auto" />
              ) : (
                <img src={attachment.url} alt={attachment.filename} className="max-h-[75dvh] w-auto object-contain" />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-3">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-sm">{attachment.filename}</DialogTitle>
                <DialogDescription className="text-xs">
                  {formatBytes(attachment.size)} · {attachment.actor} ·{' '}
                  <span title={formatDateTime(attachment.createdAt)}>{formatRelative(attachment.createdAt)}</span>
                </DialogDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => copyMarkdown(attachment)}>
                <CopyIcon />
                Copy markdown
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <a href={attachment.url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon />
                  Open original
                </a>
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmingDelete(true)}>
                <Trash2Icon />
                Delete
              </Button>
            </div>
            <ConfirmDialog
              open={confirmingDelete}
              onOpenChange={setConfirmingDelete}
              title={`Delete ${attachment.filename}?`}
              description="The file will be permanently deleted."
              confirmLabel="Delete attachment"
              onConfirm={() => {
                onClose()
                void actions.deleteAttachment(ticketId, attachment.id)
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function AttachmentsSection({ ticketId, uploads }: { ticketId: string; uploads: AttachmentUploads }) {
  const { data: attachments = [] } = useTicketAttachments(ticketId)
  const [dragging, setDragging] = useState(false)
  const [viewing, setViewing] = useState<Attachment | null>(null)

  const browse = async () => uploads.upload(await pickFiles(ATTACHMENT_TYPES.join(','), { multiple: true }))

  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      setDragging(false)
      void uploads.upload([...event.dataTransfer.files])
    },
  }

  const empty = attachments.length === 0 && uploads.uploading === 0

  return (
    <section aria-labelledby="attachments-heading" className="grid gap-3" {...dropProps}>
      <div className="flex items-center gap-2">
        <h3 id="attachments-heading" className="text-sm font-medium">
          Attachments
        </h3>
        {attachments.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{attachments.length}</span>
        )}
      </div>

      {empty ? (
        <button
          type="button"
          onClick={browse}
          className={cn(
            'flex items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground',
            dragging && 'border-ring bg-muted text-foreground',
          )}
        >
          <PaperclipIcon className="size-4" />
          Drop screenshots or recordings, paste, or browse
        </button>
      ) : (
        <ul
          className={cn(
            'grid grid-cols-2 gap-2 rounded-lg transition-shadow sm:grid-cols-3',
            dragging && 'ring-2 ring-ring ring-offset-4 ring-offset-popover',
          )}
        >
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <button
                type="button"
                onClick={() => setViewing(attachment)}
                title={attachment.filename}
                className="group block w-full rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <AttachmentThumbnail
                  attachment={attachment}
                  className="aspect-video transition-colors group-hover:border-foreground/30"
                />
                <span className="mt-1 block truncate px-0.5 text-xs text-muted-foreground">{attachment.filename}</span>
              </button>
            </li>
          ))}
          {Array.from({ length: uploads.uploading }, (_, index) => (
            <li key={`uploading-${index}`} className="aspect-video animate-pulse rounded-lg border bg-muted" />
          ))}
          <li>
            <button
              type="button"
              onClick={browse}
              className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <PlusIcon className="size-4" />
              Add
            </button>
          </li>
        </ul>
      )}

      <AttachmentViewer ticketId={ticketId} attachment={viewing} onClose={() => setViewing(null)} />
    </section>
  )
}
