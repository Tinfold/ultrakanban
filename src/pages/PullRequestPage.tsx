import {
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  SquareKanbanIcon,
} from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'wouter'
import { localPullRequestUrl, type LocalPullRequestState } from '@shared/domain'
import { AppHeader } from '@/components/app/AppHeader'
import { Conversation } from '@/components/pull-request/Conversation'
import { FilesChanged } from '@/components/pull-request/FilesChanged'
import { Button } from '@/components/ui/button'
import { useLocalPullRequest, useLocalPullRequestDiff } from '@/hooks/queries'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

const STATES = {
  open: { label: 'Open', icon: GitPullRequestIcon, className: 'bg-emerald-600' },
  merged: { label: 'Merged', icon: GitMergeIcon, className: 'bg-violet-600' },
  closed: { label: 'Closed', icon: GitPullRequestClosedIcon, className: 'bg-red-600' },
} satisfies Record<LocalPullRequestState, unknown>

function StateBadge({ state }: { state: LocalPullRequestState }) {
  const { label, icon: Icon, className } = STATES[state]
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium text-white', className)}
    >
      <Icon className="size-4" />
      {label}
    </span>
  )
}

function Branch({ name }: { name: string }) {
  return <code className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-xs text-sky-700 dark:text-sky-300">{name}</code>
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm',
        active
          ? 'border-orange-500 font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </Link>
  )
}

/** A board's local pull request (see `LocalPullRequest`), laid out like one on GitHub: Conversation and Files changed. */
export function PullRequestPage({ boardId, number, tab }: { boardId: string; number: number; tab?: string }) {
  const { data: pullRequest, error, isPending } = useLocalPullRequest(boardId, number)
  const { data: diff } = useLocalPullRequestDiff(boardId, number)
  const url = localPullRequestUrl(boardId, number)
  const files = tab === 'files'

  useEffect(() => {
    if (pullRequest) document.title = `${pullRequest.title} · Pull request #${number} · ultrakanban`
  }, [pullRequest, number])

  // Links to a comment (`#comment-<id>`) or a file (`#file-<path>`) scroll to it once it is there.
  const loaded = !!pullRequest
  const diffLoaded = !!diff
  useEffect(() => {
    if (loaded && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [loaded, diffLoaded, files])

  if (isPending) return <AppHeader boardId={boardId} />

  if (error || !pullRequest) {
    return (
      <>
        <AppHeader boardId={boardId} />
        <div className="grid flex-1 place-content-center justify-items-center gap-3 p-6 text-center">
          <h1 className="text-lg font-semibold">Pull request not found</h1>
          <p className="text-sm text-muted-foreground">{error?.message ?? 'It may have been deleted.'}</p>
          <Button asChild variant="outline">
            <Link href={`/b/${boardId}`}>Go to the board</Link>
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <AppHeader boardId={boardId} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl gap-4 px-4 py-6">
          <header className="grid gap-2">
            <h1 className="text-2xl font-semibold break-words">
              {pullRequest.title} <span className="font-normal text-muted-foreground">#{pullRequest.number}</span>
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <StateBadge state={pullRequest.state} />
              <span>
                <span className="font-medium text-foreground">{pullRequest.author}</span>{' '}
                {pullRequest.state === 'merged' ? 'merged' : 'wants to merge'} <Branch name={pullRequest.head} /> into{' '}
                <Branch name={pullRequest.base} />
              </span>
              <span>
                · opened{' '}
                <time dateTime={pullRequest.createdAt} title={formatDateTime(pullRequest.createdAt)}>
                  {formatRelative(pullRequest.createdAt)}
                </time>
              </span>
              {pullRequest.ticketId && (
                <Link
                  href={`/b/${boardId}?ticket=${pullRequest.ticketId}`}
                  className="ml-auto flex items-center gap-1 text-foreground hover:underline"
                >
                  <SquareKanbanIcon className="size-4" />
                  Ticket #{pullRequest.ticketNumber}
                </Link>
              )}
            </div>
          </header>
          <nav className="flex border-b" aria-label="Pull request">
            <TabLink href={url} active={!files}>
              <MessageSquareIcon className="size-4" />
              Conversation
              <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{pullRequest.commentCount}</span>
            </TabLink>
            <TabLink href={`${url}/files`} active={files}>
              <FileDiffIcon className="size-4" />
              Files changed
              {diff && <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{diff.files.length}</span>}
            </TabLink>
          </nav>
          {files ? (
            <FilesChanged pullRequest={pullRequest} />
          ) : (
            <Conversation pullRequest={pullRequest} filesUrl={`${url}/files`} />
          )}
        </div>
      </main>
    </>
  )
}
