import { SendHorizontalIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import { type Activity, type Attachment, parsePullRequestUrl } from '@shared/domain'
import { Markdown } from '@/components/common/Markdown'
import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { useTicketActivity, useTicketAttachments } from '@/hooks/queries'
import { formatDateTime, formatRelative } from '@/lib/format'
import { useBoardContext } from '../board/board-context'
import { AttachmentThumbnail, AttachmentViewer } from './attachments'

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  dueDate: 'due date',
  agentEffort: 'agent effort',
  agentModel: 'agent model',
  tags: 'tags',
}

const PULL_REQUEST_EVENTS = {
  open: 'is open',
  draft: 'was converted to a draft',
  merged: 'was merged',
  closed: 'was closed',
} as const

function PullRequestLink({ url }: { url: string }) {
  const pullRequest = parsePullRequestUrl(url)
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-foreground hover:underline">
      {pullRequest ? `${pullRequest.repo}#${pullRequest.number}` : url}
    </a>
  )
}

function describe(entry: Exclude<Activity, { type: 'comment' | 'attachment' }>) {
  switch (entry.type) {
    case 'pull_request': {
      const { event, url } = entry.data
      return event === 'linked' || event === 'unlinked' ? (
        <>
          {event} pull request <PullRequestLink url={url} />
        </>
      ) : (
        <>
          reports pull request <PullRequestLink url={url} /> {PULL_REQUEST_EVENTS[event]}
        </>
      )
    }
    case 'created':
      return <>created this in {entry.data.column}</>
    case 'updated':
      return <>updated {entry.data.fields.map((field) => FIELD_LABELS[field] ?? field).join(', ')}</>
    case 'checked':
      return (
        <>
          {entry.data.checked ? 'checked off' : 'unchecked'} <span className="text-foreground">{entry.data.item}</span>
        </>
      )
    case 'moved':
      return (
        <>
          moved this from {entry.data.from} to <span className="text-foreground">{entry.data.to}</span>
        </>
      )
    case 'claimed':
      return entry.actor === entry.data.assignee ? (
        <>claimed this</>
      ) : (
        <>
          assigned <span className="text-foreground">{entry.data.assignee}</span>
        </>
      )
    case 'released':
      return entry.actor === entry.data.assignee ? <>released this</> : <>unassigned {entry.data.assignee}</>
  }
}

function Timestamp({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className="shrink-0 text-muted-foreground">
      {formatRelative(iso)}
    </time>
  )
}

function EventLine({ entry, children }: { entry: Activity; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <UserAvatar name={entry.actor} size="xs" />
      <p className="min-w-0">
        <span className="font-medium text-foreground">{entry.actor}</span> {children}
        <span aria-hidden> · </span>
        <Timestamp iso={entry.createdAt} />
      </p>
    </div>
  )
}

interface ActivityItemProps {
  entry: Activity
  attachmentsById: Map<string, Attachment>
  onViewAttachment: (attachment: Attachment) => void
}

function ActivityItem({ entry, attachmentsById, onViewAttachment }: ActivityItemProps) {
  if (entry.type === 'comment') {
    return (
      <li className="rounded-lg border bg-card">
        <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
          <UserAvatar name={entry.actor} size="xs" />
          <span className="font-medium">{entry.actor}</span>
          <Timestamp iso={entry.createdAt} />
        </div>
        <Markdown className="px-3 py-2.5">{entry.data.body}</Markdown>
      </li>
    )
  }
  if (entry.type === 'attachment') {
    const attachment = attachmentsById.get(entry.data.attachmentId)
    return (
      <li className="grid gap-2 px-1 text-xs text-muted-foreground">
        <EventLine entry={entry}>
          attached{' '}
          {attachment ? (
            <span className="text-foreground">{attachment.filename}</span>
          ) : (
            <>
              <s>{entry.data.filename}</s> (deleted)
            </>
          )}
        </EventLine>
        {attachment && (
          <button
            type="button"
            onClick={() => onViewAttachment(attachment)}
            className="ml-7 w-56 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AttachmentThumbnail attachment={attachment} className="aspect-video hover:border-foreground/30" />
          </button>
        )}
      </li>
    )
  }
  return (
    <li className="px-1 text-xs text-muted-foreground">
      <EventLine entry={entry}>{describe(entry)}</EventLine>
    </li>
  )
}

function CommentComposer({ ticketId }: { ticketId: string }) {
  const { actions } = useBoardContext()
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!body.trim() || sending) return
    setSending(true)
    const comment = await actions.addComment(ticketId, body.trim())
    setSending(false)
    if (comment) setBody('')
  }

  return (
    <form onSubmit={submit} className="rounded-lg border bg-card focus-within:border-ring/60">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit()
        }}
        placeholder="Leave a comment… (markdown supported)"
        className="min-h-20 resize-y border-0 bg-transparent! shadow-none focus-visible:ring-0"
      />
      <div className="flex items-center justify-end gap-2 px-2 pb-2">
        <span className="hidden text-xs text-muted-foreground sm:inline">
          <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
        </span>
        <Button type="submit" size="sm" disabled={!body.trim() || sending}>
          <SendHorizontalIcon />
          Comment
        </Button>
      </div>
    </form>
  )
}

export function ActivityFeed({ ticketId }: { ticketId: string }) {
  const { data: activity = [] } = useTicketActivity(ticketId)
  const { data: attachments = [] } = useTicketAttachments(ticketId)
  const attachmentsById = useMemo(() => new Map(attachments.map((item) => [item.id, item])), [attachments])
  const [viewing, setViewing] = useState<Attachment | null>(null)

  return (
    <section aria-labelledby="activity-heading" className="grid gap-4">
      <h3 id="activity-heading" className="text-sm font-medium">
        Activity
      </h3>
      <ol className="grid gap-3">
        {activity.map((entry) => (
          <ActivityItem key={entry.id} entry={entry} attachmentsById={attachmentsById} onViewAttachment={setViewing} />
        ))}
      </ol>
      <CommentComposer ticketId={ticketId} />
      <AttachmentViewer ticketId={ticketId} attachment={viewing} onClose={() => setViewing(null)} />
    </section>
  )
}
