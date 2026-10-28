import { useMemo } from 'react'
import { Link } from 'wouter'
import type { OverviewActivity } from '@shared/domain'
import { UserAvatar } from '@/components/common/UserAvatar'
import { formatDateTime, formatRelative, ticketRef } from '@/lib/format'
import { activityVerb, type ActivityGroup, mergeActivity, ticketHref } from '@/lib/overview'

/** The raw events of a merged entry, one per line, for its tooltip. */
const rawEvents = (group: ActivityGroup) =>
  group.events
    .map(
      (entry) =>
        `${formatDateTime(entry.createdAt)} ${entry.actor} ${activityVerb(entry)} ${ticketRef(group.ticket.number)}`,
    )
    .join('\n')

interface RecentActivityProps {
  /** Newest first. */
  activity: OverviewActivity[]
  /** The most entries to show, after merging. */
  limit?: number
}

export function RecentActivity({ activity, limit }: RecentActivityProps) {
  const groups = useMemo(() => mergeActivity(activity).slice(0, limit), [activity, limit])
  if (!groups.length) return <p className="px-1 text-sm text-muted-foreground">No activity yet.</p>

  return (
    <ol className="grid grid-cols-1 content-start gap-2.5 rounded-xl border bg-card p-3">
      {groups.map((group) => (
        <li
          key={group.id}
          className="flex gap-2 text-xs text-muted-foreground"
          title={group.events.length > 1 ? rawEvents(group) : undefined}
        >
          <UserAvatar name={group.actor} size="xs" />
          <p className="min-w-0">
            <span className="font-medium text-foreground">{group.actor}</span> {group.verb}{' '}
            <Link href={ticketHref({ id: group.ticketId, boardId: group.ticket.boardId })} className="hover:underline">
              <span className="font-mono">{ticketRef(group.ticket.number)}</span>{' '}
              <span className="text-foreground">{group.ticket.title}</span>
            </Link>
            {group.column && <> · {group.column}</>}
            <span className="block">
              {group.ticket.boardName} ·{' '}
              <time dateTime={group.createdAt} title={formatDateTime(group.createdAt)}>
                {formatRelative(group.createdAt)}
              </time>
              {group.events.length > 1 && ` · ${group.events.length} events`}
            </span>
          </p>
        </li>
      ))}
    </ol>
  )
}
