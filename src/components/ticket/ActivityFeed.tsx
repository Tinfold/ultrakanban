import { ChevronRightIcon, SendHorizontalIcon, SquareIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import {
  type Activity,
  type AgentRun,
  type Attachment,
  parsePullRequestUrl,
  type PullRequest,
  type RunOutcome,
  type RunRecord,
} from '@shared/domain'
import { Markdown } from '@/components/common/Markdown'
import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { useTicketActivity, useTicketAttachments, useTicketRuns } from '@/hooks/queries'
import { formatDateTime, formatRelative, formatRunOutcome, formatRunTotals } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useBoardContext } from '../board/board-context'
import { AttachmentThumbnail, AttachmentViewer } from './attachments'
import { RunSteps } from './RunSteps'

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

function describe(entry: Exclude<Activity, { type: 'comment' | 'plan' | 'attachment' }>) {
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
    case 'approved':
      return <>approved the plan{entry.data.estimate && <> (size {entry.data.estimate})</>}</>
    case 'stopped':
      return <>stopped the agent&apos;s run{entry.data.step && <> ({entry.data.step})</>}</>
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
  if (entry.type === 'comment' || entry.type === 'plan') {
    return (
      <li className="rounded-lg border bg-card">
        <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
          <UserAvatar name={entry.actor} size="xs" />
          <span className="font-medium">{entry.actor}</span>
          {entry.type === 'plan' && (
            <span className="text-muted-foreground">
              posted a plan, size <span className="font-medium text-foreground">{entry.data.estimate}</span>
              {entry.data.held && ', and waits for approval'}
            </span>
          )}
          <Timestamp iso={entry.createdAt} />
          {entry.type === 'comment' && entry.data.pullRequestComment && (
            <a
              href={entry.data.pullRequestComment}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-muted-foreground hover:text-foreground hover:underline"
            >
              also on the pull request
            </a>
          )}
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

/** How each outcome of a run looks: runs that failed stand out, finished ones don't need to. */
const OUTCOME_STYLES: Record<RunOutcome, { item: string; label: string }> = {
  finished: { item: '', label: 'text-emerald-600 dark:text-emerald-400' },
  failed: { item: 'border-red-500/40 bg-red-500/5', label: 'text-red-600 dark:text-red-400' },
  timed_out: { item: 'border-red-500/40 bg-red-500/5', label: 'text-red-600 dark:text-red-400' },
  killed: { item: 'border-red-500/40 bg-red-500/5', label: 'text-red-600 dark:text-red-400' },
  stopped: { item: '', label: 'text-muted-foreground' },
  stop_requested: { item: '', label: 'text-muted-foreground' },
  loop_stopped: { item: '', label: 'text-muted-foreground' },
  usage_limit: { item: 'border-amber-500/40 bg-amber-500/5', label: 'text-amber-600 dark:text-amber-400' },
}

/**
 * An agent run on the ticket (see `RunRecord`), collapsed to one line saying how long it took and how it ended; open, it
 * shows the run's final message and the tool calls it made.
 */
function RunItem({ run }: { run: RunRecord }) {
  const [open, setOpen] = useState(false)
  const styles = OUTCOME_STYLES[run.outcome]
  const totals = formatRunTotals(run)

  return (
    <li className={cn('rounded-lg border bg-card text-xs', styles.item)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground', open && 'rotate-90')} />
        <UserAvatar name={run.agent} size="xs" />
        <p className="min-w-0 text-muted-foreground">
          <span className="font-medium text-foreground">{run.agent}</span> Run
          {totals && <> · {totals}</>}
          <span aria-hidden> · </span>
          <span className={cn('font-medium', styles.label)}>{formatRunOutcome(run)}</span>
          <span aria-hidden> · </span>
          <Timestamp iso={run.createdAt} />
        </p>
      </button>
      {open && (
        <div className="grid gap-2 border-t px-3 py-2.5">
          {run.message ? (
            <Markdown>{run.message}</Markdown>
          ) : (
            <p className="text-muted-foreground">The run left no final message.</p>
          )}
          {run.steps.length > 0 && <RunSteps run={run} />}
        </div>
      )}
    </li>
  )
}

/** The ticket's activity and its agent runs, oldest first: a run shows when it ended, among what happened meanwhile. */
type FeedEntry = { kind: 'activity'; entry: Activity } | { kind: 'run'; run: RunRecord }

function feedEntries(activity: Activity[], runs: RunRecord[]): FeedEntry[] {
  const entries: FeedEntry[] = activity.map((entry) => ({ kind: 'activity', entry }))
  for (const run of [...runs].reverse()) {
    const at = entries.findIndex((item) => item.kind === 'activity' && item.entry.createdAt > run.createdAt)
    entries.splice(at === -1 ? entries.length : at, 0, { kind: 'run', run })
  }
  return entries
}

interface CommentComposerProps {
  ticketId: string
  pullRequest: PullRequest | null
  /** The agent run working the ticket: while it goes on, a comment can stop it too, to redirect the agent. */
  run: AgentRun | null
}

function CommentComposer({ ticketId, pullRequest, run }: CommentComposerProps) {
  const { actions } = useBoardContext()
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [onPullRequest, setOnPullRequest] = useState(false)
  // Merged and closed pull requests aren't where review feedback goes any more.
  const canPostOnPullRequest = pullRequest?.state === 'open' || pullRequest?.state === 'draft'
  // Once a stop is asked for, the run resumes with any new comment anyway.
  const canStopRun = run !== null && !run.stopRequested

  /** Posts the comment; with `stopRun`, then stops the agent's run, which carries on with the comment. */
  const submit = async (event?: FormEvent, stopRun = false) => {
    event?.preventDefault()
    if (!body.trim() || sending) return
    setSending(true)
    const post = stopRun ? actions.commentAndStopRun : actions.addComment
    const comment = await post(ticketId, body.trim(), canPostOnPullRequest && onPullRequest)
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
      <div className="flex flex-wrap items-center justify-end gap-2 px-2 pb-2">
        {canPostOnPullRequest && (
          <label className="mr-auto flex items-center gap-1.5 px-1 text-xs text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={onPullRequest}
              onChange={(event) => setOnPullRequest(event.target.checked)}
              className="size-3.5 accent-primary"
            />
            Also post on {pullRequest.repo}#{pullRequest.number}
          </label>
        )}
        <span className="hidden text-xs text-muted-foreground sm:inline">
          <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
        </span>
        {canStopRun && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!body.trim() || sending}
            title="Post the comment and stop the agent's run: it carries on where it left off, with your comment as new instructions"
            onClick={() => void submit(undefined, true)}
          >
            <SquareIcon />
            Comment and stop run
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!body.trim() || sending}>
          <SendHorizontalIcon />
          Comment
        </Button>
      </div>
    </form>
  )
}

export function ActivityFeed({ ticketId, pullRequest, run }: CommentComposerProps) {
  const { data: activity = [] } = useTicketActivity(ticketId)
  const { data: runs = [] } = useTicketRuns(ticketId)
  const { data: attachments = [] } = useTicketAttachments(ticketId)
  const attachmentsById = useMemo(() => new Map(attachments.map((item) => [item.id, item])), [attachments])
  const entries = useMemo(() => feedEntries(activity, runs), [activity, runs])
  const [viewing, setViewing] = useState<Attachment | null>(null)

  return (
    <section aria-labelledby="activity-heading" className="grid gap-4">
      <h3 id="activity-heading" className="text-sm font-medium">
        Activity
      </h3>
      <ol className="grid gap-3">
        {entries.map((item) =>
          item.kind === 'run' ? (
            <RunItem key={`run-${item.run.id}`} run={item.run} />
          ) : (
            <ActivityItem
              key={item.entry.id}
              entry={item.entry}
              attachmentsById={attachmentsById}
              onViewAttachment={setViewing}
            />
          ),
        )}
      </ol>
      <CommentComposer ticketId={ticketId} pullRequest={pullRequest} run={run} />
      <AttachmentViewer ticketId={ticketId} attachment={viewing} onClose={() => setViewing(null)} />
    </section>
  )
}
