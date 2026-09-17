import type { PullRequestState } from '@shared/domain'

export const PULL_REQUEST_STATE_LABELS: Record<PullRequestState, string> = {
  unknown: 'Checking…',
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}
