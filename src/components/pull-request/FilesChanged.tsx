import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from 'lucide-react'
import { Fragment, useState } from 'react'
import type { DiffFile, DiffLine, DiffSide, LocalPullRequestComment, LocalPullRequestDetail } from '@shared/domain'
import { Markdown } from '@/components/common/Markdown'
import { UserAvatar } from '@/components/common/UserAvatar'
import { useLocalPullRequestDiff } from '@/hooks/queries'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CommentForm } from './CommentForm'

/** Where a comment on the line goes, as on GitHub: a deleted line on the left (the base's), any other on the right. */
function placeOf(line: DiffLine): { side: DiffSide; line: number } {
  return line.type === 'delete' ? { side: 'left', line: line.oldLine! } : { side: 'right', line: line.newLine! }
}

const placeKey = (path: string, side: DiffSide, line: number) => `${side}:${line}:${path}`

const LINE_STYLES = {
  add: { row: 'bg-emerald-500/15', gutter: 'bg-emerald-500/25', sign: '+' },
  delete: { row: 'bg-red-500/15', gutter: 'bg-red-500/25', sign: '-' },
  context: { row: '', gutter: '', sign: ' ' },
} as const

const STATUS_LABELS: Record<DiffFile['status'], string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  copied: 'Copied',
}

function InlineComment({ comment }: { comment: LocalPullRequestComment }) {
  return (
    <div
      id={`comment-${comment.id}`}
      className="font-sans flex scroll-mt-16 gap-2 border-t bg-background px-3 py-2 first:border-t-0"
    >
      <UserAvatar name={comment.author} size="xs" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-xs">
          <span className="font-medium">{comment.author}</span>{' '}
          <time
            dateTime={comment.createdAt}
            title={formatDateTime(comment.createdAt)}
            className="text-muted-foreground"
          >
            {formatRelative(comment.createdAt)}
          </time>
        </p>
        <Markdown className="text-sm">{comment.body}</Markdown>
      </div>
    </div>
  )
}

interface FileDiffProps {
  file: DiffFile
  pullRequest: LocalPullRequestDetail
  comments: Map<string, LocalPullRequestComment[]>
}

/** One file's diff, collapsible, with a comment form under the line being commented on. */
function FileDiff({ file, pullRequest, comments }: FileDiffProps) {
  const [open, setOpen] = useState(true)
  const [commenting, setCommenting] = useState<string | null>(null)

  return (
    <section className="overflow-hidden rounded-lg border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          'sticky top-0 z-10 flex w-full items-center gap-2 bg-muted/60 px-3 py-2 text-left text-sm backdrop-blur hover:bg-muted',
          open && 'border-b',
        )}
      >
        {open ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABELS[file.status]}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
        </span>
      </button>
      {open &&
        (file.binary || !file.hunks.length ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            {file.binary ? 'Binary file not shown.' : 'No changes to show.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs leading-5">
              <tbody>
                {file.hunks.map((hunk) => (
                  <Fragment key={hunk.header}>
                    <tr className="bg-sky-500/10 text-muted-foreground">
                      <td colSpan={3} className="px-3 py-1 whitespace-pre">
                        {hunk.header}
                      </td>
                    </tr>
                    {hunk.lines.map((line, index) => {
                      const place = placeOf(line)
                      const key = placeKey(file.path, place.side, place.line)
                      const lineComments = comments.get(key) ?? []
                      const style = LINE_STYLES[line.type]
                      return (
                        <Fragment key={index}>
                          <tr
                            className={cn('group/line cursor-pointer', style.row, 'hover:brightness-95')}
                            title="Comment on this line"
                            // Not when the click ends selecting text to copy.
                            onClick={() => !window.getSelection()?.toString() && setCommenting(key)}
                          >
                            <td
                              className={cn(
                                'relative w-12 min-w-12 border-r px-2 text-right text-muted-foreground select-none',
                                style.gutter,
                              )}
                            >
                              <PlusIcon
                                aria-hidden
                                className="absolute top-0.5 -right-2 z-1 hidden size-4 rounded bg-blue-600 p-0.5 text-white group-hover/line:block"
                              />
                              {line.oldLine ?? ''}
                            </td>
                            <td
                              className={cn(
                                'w-12 min-w-12 border-r px-2 text-right text-muted-foreground select-none',
                                style.gutter,
                              )}
                            >
                              {line.newLine ?? ''}
                            </td>
                            <td className="px-3 whitespace-pre">
                              <span className="select-none">{style.sign}</span>
                              {line.text}
                            </td>
                          </tr>
                          {(lineComments.length > 0 || commenting === key) && (
                            <tr>
                              <td colSpan={3} className="border-y bg-muted/30 p-2">
                                <div className="max-w-3xl overflow-hidden rounded-md border bg-background">
                                  {lineComments.map((comment) => (
                                    <InlineComment key={comment.id} comment={comment} />
                                  ))}
                                  {commenting === key && (
                                    <div className={cn('p-2 font-sans', lineComments.length > 0 && 'border-t')}>
                                      <CommentForm
                                        boardId={pullRequest.boardId}
                                        number={pullRequest.number}
                                        inline={{ path: file.path, ...place }}
                                        autoFocus
                                        onDone={() => setCommenting(null)}
                                      />
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  )
}

/** The Files changed tab: each file's diff, with inline comments under their lines. */
export function FilesChanged({ pullRequest }: { pullRequest: LocalPullRequestDetail }) {
  const { data, error, isPending } = useLocalPullRequestDiff(pullRequest.boardId, pullRequest.number)

  if (isPending) return <p className="py-8 text-center text-sm text-muted-foreground">Loading the diff…</p>
  if (error || !data) {
    return <p className="py-8 text-center text-sm text-destructive">{error?.message ?? "Couldn't load the diff."}</p>
  }
  if (!data.files.length) return <p className="py-8 text-center text-sm text-muted-foreground">No files changed.</p>

  const comments = new Map<string, LocalPullRequestComment[]>()
  for (const comment of pullRequest.comments) {
    if (!comment.path || !comment.line) continue
    const key = placeKey(comment.path, comment.side ?? 'right', comment.line)
    comments.set(key, [...(comments.get(key) ?? []), comment])
  }
  const additions = data.files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = data.files.reduce((sum, file) => sum + file.deletions, 0)

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        {data.files.length} {data.files.length === 1 ? 'file' : 'files'} changed,{' '}
        <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{' '}
        <span className="text-red-600 dark:text-red-400">−{deletions}</span>
      </p>
      {data.files.map((file) => (
        <FileDiff key={file.path} file={file} pullRequest={pullRequest} comments={comments} />
      ))}
    </div>
  )
}
