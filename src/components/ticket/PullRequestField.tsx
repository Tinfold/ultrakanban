import { GitPullRequestIcon, MoreHorizontalIcon, RefreshCwIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { parsePullRequestUrl, type Ticket } from '@shared/domain'
import { PullRequestIcon } from '@/components/common/PullRequestIcon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { formatRelative } from '@/lib/format'
import { PULL_REQUEST_STATE_LABELS } from '@/lib/pull-request'
import { useBoardContext } from '../board/board-context'

/** Shows the ticket's GitHub pull request and lets people link, refresh or unlink it. */
export function PullRequestField({ ticket }: { ticket: Ticket }) {
  const { actions } = useBoardContext()
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const pullRequest = ticket.pullRequest

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = String(new FormData(event.currentTarget).get('url') ?? '').trim()
    if (!parsePullRequestUrl(url)) return setError('Paste a link like https://github.com/owner/repo/pull/123')
    setEditing(false)
    void actions.linkPullRequest(ticket.id, url)
  }

  const refresh = async () => {
    setSyncing(true)
    await actions.syncPullRequest(ticket.id)
    setSyncing(false)
  }

  return (
    <Popover
      open={editing}
      onOpenChange={(open) => {
        setEditing(open)
        setError(null)
      }}
    >
      <PopoverAnchor asChild>
        {pullRequest ? (
          <div className="flex min-h-7 items-center gap-1 rounded-md pl-2 hover:bg-muted">
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              title={`${pullRequest.repo}#${pullRequest.number} (${PULL_REQUEST_STATE_LABELS[pullRequest.state]})${pullRequest.title ? `: ${pullRequest.title}` : ''}`}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-sm"
            >
              <PullRequestIcon state={pullRequest.state} />
              <span className="truncate">
                {pullRequest.repo.split('/')[1]}#{pullRequest.number}
              </span>
            </a>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Pull request actions">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem disabled={syncing} onSelect={refresh}>
                  <RefreshCwIcon className={syncing ? 'animate-spin' : undefined} />
                  Check status now
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEditing(true)}>Change link</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => actions.linkPullRequest(ticket.id, null)}>
                  Unlink
                </DropdownMenuItem>
                {pullRequest.checkedAt && (
                  <p className="px-1.5 pt-1.5 pb-1 text-xs text-muted-foreground">
                    Checked {formatRelative(pullRequest.checkedAt)}
                  </p>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto min-h-7 w-full justify-start px-2 py-1 font-normal text-muted-foreground"
            onClick={() => setEditing(true)}
          >
            <GitPullRequestIcon />
            Link pull request
          </Button>
        )}
      </PopoverAnchor>
      <PopoverContent align="start" className="w-80 p-2">
        <form onSubmit={submit} className="grid gap-1.5">
          <div className="flex gap-1.5">
            <Input
              name="url"
              autoFocus
              defaultValue={pullRequest?.url}
              placeholder="https://github.com/owner/repo/pull/123"
              aria-invalid={!!error}
              className="h-7"
              onChange={() => setError(null)}
            />
            <Button type="submit" size="sm">
              Link
            </Button>
          </div>
          {error && <p className="px-0.5 text-xs text-destructive">{error}</p>}
        </form>
      </PopoverContent>
    </Popover>
  )
}
