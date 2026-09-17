import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  type LucideIcon,
} from 'lucide-react'
import type { PullRequestState } from '@shared/domain'
import { PULL_REQUEST_STATE_LABELS } from '@/lib/pull-request'
import { cn } from '@/lib/utils'

const ICONS: Record<PullRequestState, { icon: LucideIcon; className: string }> = {
  unknown: { icon: GitPullRequestIcon, className: 'text-muted-foreground' },
  open: { icon: GitPullRequestIcon, className: 'text-emerald-600 dark:text-emerald-400' },
  draft: { icon: GitPullRequestDraftIcon, className: 'text-muted-foreground' },
  merged: { icon: GitMergeIcon, className: 'text-violet-600 dark:text-violet-400' },
  closed: { icon: GitPullRequestClosedIcon, className: 'text-red-600 dark:text-red-400' },
}

export function PullRequestIcon({ state, className }: { state: PullRequestState; className?: string }) {
  const { icon: Icon, className: stateClass } = ICONS[state]
  return <Icon aria-label={PULL_REQUEST_STATE_LABELS[state]} className={cn('size-4 shrink-0', stateClass, className)} />
}
