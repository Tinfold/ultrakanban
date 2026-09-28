import type { CheckStatus, MergeMethod, PullRequestState } from '@shared/domain'

export const PULL_REQUEST_STATE_LABELS: Record<PullRequestState, string> = {
  unknown: 'Checking…',
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}

export const CONFLICTS_HINT = 'The pull request has merge conflicts with its base branch'

export const CHECKS_HINTS: Record<CheckStatus, string> = {
  pending: 'The pull request has checks still running',
  passing: 'The pull request has passed its checks',
  failing: 'The pull request has failing checks',
}

export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
}
