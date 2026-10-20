import {
  type CheckStatus,
  FAILING_CHECK_EXCERPT_MAX,
  FAILING_CHECK_EXCERPTS,
  type FailingCheck,
  isBillingFailure,
  MAX_FAILING_CHECKS,
} from '../shared/domain.ts'
import type { GitHubAnnotation, GitHubCheckRun, GitHubClient, GitHubCommitStatus } from './github.ts'

/**
 * Check run conclusions that count as failing, the ones scripts/agent-loop/ci.sh looks at. The loop tells failures of
 * the code (`failure`) from CI's own (`timed_out`, `startup_failure`, `action_required`) to decide whether to start a
 * run, but either way the check didn't pass, so the board shows them all, with their conclusion.
 */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

/**
 * Conclusions that count as passing, as GitHub's branch protection counts them. Cancelled and stale runs count as
 * neither, as in ci.sh: they were stopped or replaced, so they say nothing about the commit.
 */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])

/** A commit's checks as the board stores them for its pull request (see `PullRequest`). */
export interface CommitChecks {
  checks: CheckStatus | null
  failingChecks: FailingCheck[]
}

/** What the board last stored of a pull request's checks, whose excerpts `fetchCommitChecks` reuses. */
interface PreviousChecks {
  headSha: string | null
  failingChecks: FailingCheck[]
}

/** A failing check, and the check run it is (null for a commit status), whose details give its excerpt. */
interface Failing {
  check: FailingCheck
  run: GitHubCheckRun | null
}

const clip = (text: string | null) => {
  const trimmed = text?.trim()
  if (!trimmed) return null
  return trimmed.length > FAILING_CHECK_EXCERPT_MAX ? `${trimmed.slice(0, FAILING_CHECK_EXCERPT_MAX - 1)}…` : trimmed
}

/**
 * Combines a commit's check runs (GitHub Actions and other apps) and commit statuses (older CI integrations) into one
 * state, so repositories with either, or both, show theirs: `failing` once any didn't pass, otherwise `pending` while
 * any is still running, otherwise `passing` once any passed. Null when none counts (it has none, or only cancelled
 * ones). Of each check run name only the latest run counts, as a re-run replaces the earlier one. Also lists the
 * failing ones by name, at most `MAX_FAILING_CHECKS`: commit statuses with their description as the excerpt, check
 * runs without one yet (see `fetchCommitChecks`). `failingCount` counts them all, and `pending` says whether any is
 * still running, even when one already failed.
 */
export function combineChecks(runs: GitHubCheckRun[], statuses: GitHubCommitStatus[]) {
  const latest = new Map<string, GitHubCheckRun>()
  for (const run of runs) {
    const other = latest.get(run.name)
    if (!other || run.id > other.id) latest.set(run.name, run)
  }
  let pending = false
  let passing = false
  const failing: Failing[] = []
  for (const run of latest.values()) {
    if (run.status !== 'completed') pending = true
    else if (run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion)) {
      failing.push({ check: { name: run.name, conclusion: run.conclusion, url: run.detailsUrl, excerpt: null }, run })
    } else if (run.conclusion && PASSING_CONCLUSIONS.has(run.conclusion)) passing = true
  }
  for (const status of statuses) {
    if (status.state === 'pending') pending = true
    else if (status.state === 'success') passing = true
    else {
      const check = { name: status.context, conclusion: status.state, url: status.targetUrl }
      failing.push({ check: { ...check, excerpt: clip(status.description) }, run: null })
    }
  }
  failing.sort((a, b) => a.check.name.localeCompare(b.check.name))
  const checks: CheckStatus | null = failing.length ? 'failing' : pending ? 'pending' : passing ? 'passing' : null
  return { checks, failing: failing.slice(0, MAX_FAILING_CHECKS), failingCount: failing.length, pending }
}

/** One annotation on a line of its own: where it is (unless it is on the workflow as a whole), and what it says. */
function annotationLine({ path, line, title, message }: GitHubAnnotation) {
  const where = path && path !== '.github' ? `${path}${line ? `:${line}` : ''}: ` : ''
  return `${where}${title && !message.startsWith(title) ? `${title}: ` : ''}${message}`
}

/**
 * Why a check run failed, in a few lines: its failure annotations (a failing test, a compiler error), or all of its
 * annotations when none is a failure, else its output's title and summary. Annotations take a request; the output
 * comes with the check run.
 */
async function excerptOf(github: GitHubClient, repo: string, run: GitHubCheckRun) {
  let lines: string[] = []
  if (run.output.annotationsCount > 0) {
    const annotations = (await github.listCheckRunAnnotations(repo, run.id)).filter((note) => note.message.trim())
    const failures = annotations.filter((note) => note.level === 'failure')
    lines = (failures.length ? failures : annotations).map(annotationLine)
  }
  if (!lines.length) lines = [run.output.title, run.output.summary].filter((text): text is string => !!text?.trim())
  return clip(lines.join('\n'))
}

/** Identifies a failing check, to tell whether a commit's failing checks changed since they were last read. */
const checkKey = (check: FailingCheck) => `${check.name}\n${check.conclusion}`

/**
 * Reads a commit's checks from GitHub (see `combineChecks`), with an excerpt of why each of the first
 * `FAILING_CHECK_EXCERPTS` failing check runs failed, or of every one while each excerpt so far says it failed for
 * billing (see `isBillingFailure`): a billing problem fails every job, and the board's `ignoreBillingFailures` needs to
 * know that all of them failed for it. Excerpts cost a request each, and pull requests are checked every minute, so
 * they are only fetched again when the commit or its set of failing checks changed since `previous` (what the board
 * last stored for the pull request); otherwise the stored excerpts are kept. An excerpt that can't be read is left out
 * rather than failing the read.
 */
export async function fetchCommitChecks(
  github: GitHubClient,
  repo: string,
  sha: string,
  previous: PreviousChecks,
): Promise<CommitChecks> {
  const { checks, failingChecks } = await readCommitChecks(github, repo, sha, previous)
  return { checks, failingChecks }
}

/**
 * Whether a commit's checks have all finished and some failed, but only because of billing (see `isBillingFailure`),
 * reading them from GitHub as `fetchCommitChecks` does. False when more failed than the board keeps, as the rest
 * can't be told apart.
 */
export async function failsOnlyForBilling(github: GitHubClient, repo: string, sha: string, previous: PreviousChecks) {
  const { checks, failingChecks, failingCount, pending } = await readCommitChecks(github, repo, sha, previous)
  return (
    checks === 'failing' &&
    !pending &&
    failingCount === failingChecks.length &&
    failingChecks.every((check) => isBillingFailure(check))
  )
}

async function readCommitChecks(github: GitHubClient, repo: string, sha: string, previous: PreviousChecks) {
  const [runs, statuses] = await Promise.all([github.listCheckRuns(repo, sha), github.listCommitStatuses(repo, sha)])
  const { checks, failing, failingCount, pending } = combineChecks(runs, statuses)
  const known = new Map(previous.failingChecks.map((check) => [checkKey(check), check.excerpt]))
  const unchanged =
    previous.headSha === sha &&
    known.size === failing.length &&
    failing.every(({ check }) => known.has(checkKey(check)))

  const failingChecks: FailingCheck[] = []
  let fetched = 0
  let billing = true
  for (const { check, run } of failing) {
    if (!run) failingChecks.push(check)
    else if (unchanged) failingChecks.push({ ...check, excerpt: known.get(checkKey(check)) ?? null })
    else if (fetched < FAILING_CHECK_EXCERPTS || billing) {
      fetched += 1
      const excerpt = await excerptOf(github, repo, run).catch(() => null)
      billing &&= isBillingFailure({ excerpt })
      failingChecks.push({ ...check, excerpt })
    } else failingChecks.push(check)
  }
  return { checks, failingChecks, failingCount, pending }
}
