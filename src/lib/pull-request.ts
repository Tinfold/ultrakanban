import type { MergeMethod, PullRequestState } from '@shared/domain'

export const PULL_REQUEST_STATE_LABELS: Record<PullRequestState, string> = {
  unknown: 'Checking…',
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}

export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
}
