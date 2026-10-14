import type { CheckStatus, FailingCheck, MergeMethod, PullRequestState } from '@shared/domain'

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

/** A list of names for people: `a, b and c`, or the first few and how many more. */
function nameList(names: string[], shown = 3) {
  if (names.length > shown) return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
}

/** What the pull request's check icon says: which checks fail, when some do. */
export function checksHint(status: CheckStatus, failingChecks: FailingCheck[] = []) {
  if (status !== 'failing' || !failingChecks.length) return CHECKS_HINTS[status]
  return `Failing ${failingChecks.length === 1 ? 'check' : 'checks'}: ${nameList(failingChecks.map((check) => check.name))}`
}

/** How a failing check ended, for people, when it isn't a plain failure (see `FailingCheck.conclusion`). */
export const CHECK_CONCLUSION_LABELS: Record<string, string> = {
  timed_out: 'timed out',
  startup_failure: "didn't start",
  action_required: 'needs approval to run',
  error: 'errored',
}

export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
}
