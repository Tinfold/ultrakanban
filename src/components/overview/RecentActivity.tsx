import { Link } from 'wouter'
import type { OverviewActivity } from '@shared/domain'
import { UserAvatar } from '@/components/common/UserAvatar'
import { formatDateTime, formatRelative, ticketRef } from '@/lib/format'
import { ticketHref } from '@/lib/overview'

const PULL_REQUEST_EVENTS = {
  linked: 'linked a pull request to',
  unlinked: 'unlinked the pull request of',
  open: 'reports the pull request open for',
  draft: 'reports the pull request back in draft for',
  merged: 'reports the pull request merged for',
  closed: 'reports the pull request closed for',
} as const

function verb(entry: OverviewActivity) {
  switch (entry.type) {
    case 'created':
      return 'created'
    case 'updated':
      return 'edited'
    case 'moved':
      return `moved to ${entry.data.to}`
    case 'claimed':
      return entry.actor === entry.data.assignee ? 'claimed' : `assigned ${entry.data.assignee} to`
    case 'released':
      return entry.actor === entry.data.assignee ? 'released' : `unassigned ${entry.data.assignee} from`
    case 'comment':
      return 'commented on'
    case 'attachment':
      return 'attached a file to'
    case 'pull_request':
      return PULL_REQUEST_EVENTS[entry.data.event]
  }
}

export function RecentActivity({ activity }: { activity: OverviewActivity[] }) {
  if (!activity.length) return <p className="px-1 text-sm text-muted-foreground">No activity yet.</p>

  return (
    <ol className="grid gap-2.5 rounded-xl border bg-card p-3">
      {activity.map((entry) => (
        <li key={entry.id} className="flex gap-2 text-xs text-muted-foreground">
          <UserAvatar name={entry.actor} size="xs" />
          <p className="min-w-0">
            <span className="font-medium text-foreground">{entry.actor}</span> {verb(entry)}{' '}
            <Link href={ticketHref({ id: entry.ticketId, boardId: entry.ticket.boardId })} className="hover:underline">
              <span className="font-mono">{ticketRef(entry.ticket.number)}</span>{' '}
              <span className="text-foreground">{entry.ticket.title}</span>
            </Link>
            <span className="block">
              {entry.ticket.boardName} ·{' '}
              <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
                {formatRelative(entry.createdAt)}
              </time>
            </span>
          </p>
        </li>
      ))}
    </ol>
  )
}
