import { useQueryClient } from '@tanstack/react-query'
import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'wouter'
import { toast } from 'sonner'
import type { LocalPullRequestComment, LocalPullRequestDetail } from '@shared/domain'
import { Markdown } from '@/components/common/Markdown'
import { UserAvatar } from '@/components/common/UserAvatar'
import { Button } from '@/components/ui/button'
import { queryKeys } from '@/hooks/queries'
import { api, errorMessage } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import { CommentForm } from './CommentForm'

/** A comment as GitHub shows one: who, when, and its markdown in a box. */
export function CommentCard({
  author,
  createdAt,
  body,
  id,
  children,
}: {
  author: string
  createdAt: string
  body: string
  id?: string
  children?: React.ReactNode
}) {
  return (
    <div id={id} className="flex scroll-mt-16 gap-3">
      <UserAvatar name={author} size="default" className="mt-1 hidden shrink-0 sm:flex" />
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border">
        <div className="flex flex-wrap items-center gap-x-1.5 border-b bg-muted/50 px-3 py-2 text-sm">
          <span className="font-medium">{author}</span>
          <span className="text-muted-foreground">
            commented{' '}
            <time dateTime={createdAt} title={formatDateTime(createdAt)}>
              {formatRelative(createdAt)}
            </time>
          </span>
          {children}
        </div>
        {body.trim() ? (
          <Markdown className="px-3 py-2.5">{body}</Markdown>
        ) : (
          <p className="px-3 py-2.5 text-sm text-muted-foreground italic">No description provided.</p>
        )}
      </div>
    </div>
  )
}

function InlineCommentPlace({ comment, filesUrl }: { comment: LocalPullRequestComment; filesUrl: string }) {
  return (
    <span className="text-muted-foreground">
      on{' '}
      <Link href={`${filesUrl}#comment-${comment.id}`} className="font-mono text-xs text-foreground hover:underline">
        {comment.path}:{comment.line}
      </Link>
    </span>
  )
}

/** Merge and Close for an open pull request; who merged or closed it otherwise. */
function MergeBox({ pullRequest }: { pullRequest: LocalPullRequestDetail }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<'merge' | 'close' | null>(null)
  const { boardId, number } = pullRequest

  const run = async (action: 'merge' | 'close') => {
    setBusy(action)
    try {
      await (action === 'merge' ? api.mergeLocalPullRequest : api.closeLocalPullRequest)(boardId, number)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.localPullRequests(boardId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.board(boardId) }),
      ])
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  if (pullRequest.state !== 'open') {
    const merged = pullRequest.state === 'merged'
    const Icon = merged ? GitMergeIcon : GitPullRequestClosedIcon
    return (
      <div className="flex items-center gap-3 rounded-lg border p-3 text-sm">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-full text-white ${merged ? 'bg-violet-600' : 'bg-red-600'}`}
        >
          <Icon className="size-4" />
        </span>
        <p>
          <span className="font-medium">{pullRequest.closedBy ?? 'Someone'}</span> {merged ? 'merged' : 'closed'} this
          pull request
          {pullRequest.closedAt && (
            <time dateTime={pullRequest.closedAt} title={formatDateTime(pullRequest.closedAt)}>
              {' '}
              {formatRelative(pullRequest.closedAt)}
            </time>
          )}
          {pullRequest.mergeSha && (
            <>
              {' '}
              in <code className="text-xs">{pullRequest.mergeSha.slice(0, 7)}</code>
            </>
          )}
          .
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
        <GitPullRequestIcon className="size-4" />
      </span>
      <p className="min-w-0 flex-1">
        Merge <code className="text-xs">{pullRequest.head}</code> into{' '}
        <code className="text-xs">{pullRequest.base}</code> in the board's local repository.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => run('close')}>
          Close pull request
        </Button>
        <Button
          size="sm"
          disabled={!!busy}
          className="bg-emerald-600 text-white hover:bg-emerald-700"
          onClick={() => run('merge')}
        >
          <GitMergeIcon />
          {busy === 'merge' ? 'Merging…' : 'Merge pull request'}
        </Button>
      </div>
    </div>
  )
}

/** The Conversation tab: the description, then every comment in order, then merging and a new comment. */
export function Conversation({ pullRequest, filesUrl }: { pullRequest: LocalPullRequestDetail; filesUrl: string }) {
  return (
    <div className="grid gap-4">
      <CommentCard author={pullRequest.author} createdAt={pullRequest.createdAt} body={pullRequest.body} />
      {pullRequest.comments.map((comment) => (
        <CommentCard
          key={comment.id}
          id={`comment-${comment.id}`}
          author={comment.author}
          createdAt={comment.createdAt}
          body={comment.body}
        >
          {comment.path && <InlineCommentPlace comment={comment} filesUrl={filesUrl} />}
        </CommentCard>
      ))}
      <MergeBox pullRequest={pullRequest} />
      <div className="flex gap-3">
        <span className="hidden w-8 shrink-0 sm:block" />
        <div className="flex-1">
          <CommentForm boardId={pullRequest.boardId} number={pullRequest.number} />
        </div>
      </div>
    </div>
  )
}
