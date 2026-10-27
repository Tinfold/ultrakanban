import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiffFile, DiffHunk, LocalCommit, LocalPullRequestDiff } from '../shared/domain.ts'
import { badRequest, conflict, HttpError } from './errors.ts'

/**
 * Git in a board's local repository (`BoardSummary.localRepoPath`), for its local pull requests: their diffs, commits
 * and merges. Git runs without a shell, and branches are passed as `refs/heads/<name>`, so no name can be read as an
 * option.
 */

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

const gitEnv = () => ({ ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
/** Who merge commits are by when the repository has no `user.name` and `user.email` set. */
const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: 'ultrakanban',
  GIT_AUTHOR_EMAIL: 'ultrakanban@localhost',
  GIT_COMMITTER_NAME: 'ultrakanban',
  GIT_COMMITTER_EMAIL: 'ultrakanban@localhost',
}

/** Runs git. Paths in what it writes are quoted only when they must be (see `quotePath`), whatever its config says. */
function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = gitEnv()): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const argv = ['-c', 'core.quotePath=false', ...args]
    execFile('git', argv, { cwd, env, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error)
      resolve({ code: error ? (error.code as number) : 0, stdout, stderr })
    })
  })
}

/** Runs git, failing with its message unless it exits with one of `codes`. */
async function git(
  cwd: string,
  args: string[],
  { codes = [0], env }: { codes?: number[]; env?: NodeJS.ProcessEnv } = {},
) {
  const result = await run(cwd, args, env)
  if (!codes.includes(result.code)) {
    const message = (result.stderr || result.stdout).trim() || `exited with ${result.code}`
    throw new HttpError(502, 'git_error', `git ${args[0]} failed: ${message}`)
  }
  return result
}

const heads = (branch: string) => `refs/heads/${branch}`

/** Where `~/` points: the host's home directory when the board runs in Docker (see docker-compose.yml), else its own. */
const home = () => process.env.ULTRAKANBAN_HOME || homedir()

/** The board's local repository, `~` expanded; fails clearly when it isn't a git repository. */
export async function openRepository(localRepoPath: string | null) {
  if (!localRepoPath) throw badRequest('This board has no local repository; set one in the board settings')
  const path = localRepoPath.startsWith('~/') ? join(home(), localRepoPath.slice(2)) : localRepoPath
  const result = await run(path, ['rev-parse', '--git-dir']).catch((error: NodeJS.ErrnoException) => {
    // A missing directory and a missing git both fail to spawn with ENOENT.
    if (error.code === 'ENOENT' && !existsSync(path)) {
      throw badRequest(
        `The board's local repository ${localRepoPath} isn't there: the board sees no ${path}. A board running in Docker sees only ULTRAKANBAN_HOME (see docs/agents.md).`,
      )
    }
    if (error.code === 'ENOENT') throw badRequest("git isn't installed where the board runs")
    return { code: -1, stdout: '', stderr: error.message }
  })
  if (result.code !== 0) {
    throw badRequest(`The board's local repository ${localRepoPath} isn't a git repository: ${result.stderr.trim()}`)
  }
  return path
}

/** The repository's default branch: the one its `HEAD` points at. */
export async function defaultBranch(repo: string) {
  // The full ref: `--short` gives `heads/main` when a tag is called `main` too.
  const { code, stdout } = await git(repo, ['symbolic-ref', '--quiet', 'HEAD'], { codes: [0, 1] })
  const ref = stdout.trim()
  if (code !== 0 || !ref.startsWith('refs/heads/')) {
    throw badRequest("The local repository's HEAD isn't on a branch; give the base branch")
  }
  return ref.slice('refs/heads/'.length)
}

/** The commit a branch is at; null when there is no such branch. */
export async function branchSha(repo: string, branch: string) {
  const { code, stdout } = await git(repo, ['rev-parse', '--verify', '--quiet', `${heads(branch)}^{commit}`], {
    codes: [0, 1],
  })
  return code === 0 ? stdout.trim() : null
}

export async function isAncestor(repo: string, ancestor: string, of: string) {
  return (await git(repo, ['merge-base', '--is-ancestor', ancestor, of], { codes: [0, 1] })).code === 0
}

/** The commit `head` branched off `base` at; fails when they share no history. */
async function mergeBase(repo: string, base: string, head: string) {
  const { code, stdout } = await git(repo, ['merge-base', base, head], { codes: [0, 1] })
  if (code !== 0) throw conflict('unrelated_histories', 'The head and base branches share no history')
  return stdout.trim()
}

/** Whether `sha` is a commit the repository still has (a deleted branch's commits may be pruned eventually). */
async function hasCommit(repo: string, sha: string) {
  return (await git(repo, ['cat-file', '-e', `${sha}^{commit}`], { codes: [0, 1, 128] })).code === 0
}

/** The commits to compare: those of an open pull request's branches, or the ones kept once it was merged or closed. */
export async function resolveCommits(
  repo: string,
  { base, head, baseSha, headSha }: { base: string; head: string; baseSha: string | null; headSha: string | null },
) {
  const resolved = { base: baseSha ?? (await branchSha(repo, base)), head: headSha ?? (await branchSha(repo, head)) }
  for (const [side, sha] of Object.entries(resolved)) {
    const branch = side === 'base' ? base : head
    if (!sha) throw conflict('branch_missing', `The local repository has no branch "${branch}"`)
    if (!(await hasCommit(repo, sha))) {
      throw conflict('commit_missing', `The local repository no longer has commit ${sha} of "${branch}"`)
    }
  }
  return resolved as { base: string; head: string }
}

const STATUSES: Record<string, DiffFile['status']> = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied' }

/** Parses `git diff --name-status -z` output. */
function parseNameStatus(output: string) {
  const fields = output.split('\0')
  const files: Pick<DiffFile, 'path' | 'oldPath' | 'status'>[] = []
  for (let i = 0; i < fields.length - 1;) {
    const status = STATUSES[fields[i][0]] ?? 'modified'
    if (status === 'renamed' || status === 'copied') {
      files.push({ status, oldPath: fields[i + 1], path: fields[i + 2] })
      i += 3
    } else {
      files.push({ status, oldPath: null, path: fields[i + 1] })
      i += 2
    }
  }
  return files
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Parses one file's part of a patch (from its `diff --git` line) into hunks, and whether it is binary. */
function parseFilePatch(lines: string[]) {
  const hunks: DiffHunk[] = []
  let binary = false
  let hunk: DiffHunk | null = null
  let oldLeft = 0
  let newLeft = 0
  let oldLine = 0
  let newLine = 0
  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const type = line[0] === '+' ? 'add' : line[0] === '-' ? 'delete' : line[0] === ' ' ? 'context' : null
      if (!type) continue // "\ No newline at end of file"
      hunk.lines.push({
        type,
        oldLine: type === 'add' ? null : oldLine++,
        newLine: type === 'delete' ? null : newLine++,
        text: line.slice(1),
      })
      if (type !== 'add') oldLeft--
      if (type !== 'delete') newLeft--
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header) {
      const [, oldStart, oldLines = '1', newStart, newLines = '1'] = header
      hunk = {
        header: line,
        oldStart: Number(oldStart),
        oldLines: Number(oldLines),
        newStart: Number(newStart),
        newLines: Number(newLines),
        lines: [],
      }
      hunks.push(hunk)
      ;[oldLeft, newLeft, oldLine, newLine] = [hunk.oldLines, hunk.newLines, hunk.oldStart, hunk.newStart]
    } else if (!hunks.length && (line.startsWith('Binary files ') || line === 'GIT binary patch')) {
      binary = true
    }
  }
  return { hunks, binary }
}

const ESCAPES: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
}

/**
 * A path as git writes it in a patch with `core.quotePath` off (see `run`): as it is, unless it has a control
 * character, `"` or `\`, which are escaped C style within double quotes.
 */
function quotePath(path: string) {
  const escape = (char: string) =>
    ESCAPES[char] ?? (char < ' ' || char === '\x7f' ? `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}` : char)
  const quoted = [...path].map(escape).join('')
  return quoted === path ? path : `"${quoted}"`
}

/**
 * Parses `git diff` output, given the files it is about (from `--name-status`). Each file's part of it is found by the
 * paths in its `diff --git` line, not by order: a file that changes type, turning into a symlink say, has two parts,
 * its deletion and its creation, and gets the hunks of both.
 */
export function parseDiff(patch: string, files: Pick<DiffFile, 'path' | 'oldPath' | 'status'>[]): DiffFile[] {
  const parts = new Map<string, string[][]>()
  let part: string[] | null = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      part = []
      parts.set(line, [...(parts.get(line) ?? []), part])
    }
    part?.push(line)
  }
  return files.map((file) => {
    const header = `diff --git ${quotePath(`a/${file.oldPath ?? file.path}`)} ${quotePath(`b/${file.path}`)}`
    const patches = (parts.get(header) ?? []).map(parseFilePatch)
    const hunks = patches.flatMap((patch) => patch.hunks)
    const binary = !hunks.length && patches.some((patch) => patch.binary)
    const count = (type: string) => hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.type === type).length, 0)
    return { ...file, binary, additions: count('add'), deletions: count('delete'), hunks }
  })
}

/** What `head` changes compared with `base`: `git diff base...head`, file by file. */
export async function diff(repo: string, base: string, head: string): Promise<LocalPullRequestDiff> {
  const baseSha = await mergeBase(repo, base, head)
  const options = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/']
  const [names, patch] = await Promise.all([
    git(repo, ['diff', ...options, '--name-status', '-z', baseSha, head]),
    git(repo, ['diff', ...options, baseSha, head]),
  ])
  return { baseSha, headSha: head, files: parseDiff(patch.stdout, parseNameStatus(names.stdout)) }
}

/** The commits on `head` that aren't on `base`, oldest first. */
export async function commits(repo: string, base: string, head: string): Promise<LocalCommit[]> {
  const format = ['%H', '%an', '%ae', '%aI', '%s', '%b'].join('%x1f') + '%x1e'
  const { stdout } = await git(repo, ['log', '--reverse', '--no-color', `--format=${format}`, `${base}..${head}`])
  return stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, author, email, date, subject, body] = record.split('\x1f')
      return { sha, author, email, date, subject, body: body.trim() }
    })
}

/** The worktree that has `branch` checked out, if any (never a bare repository). */
async function worktreeWith(repo: string, branch: string) {
  const { stdout } = await git(repo, ['worktree', 'list', '--porcelain', '-z'])
  for (const entry of stdout.split('\0\0')) {
    const fields = entry.split('\0')
    const path = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length)
    if (path && !fields.includes('bare') && fields.includes(`branch ${heads(branch)}`)) return path
  }
  return null
}

/** The identity for commits git is configured with, or `FALLBACK_IDENTITY` when there is none (never a guessed one). */
async function commitEnv(repo: string) {
  const { code } = await run(repo, ['-c', 'user.useConfigOnly=true', 'var', 'GIT_COMMITTER_IDENT'])
  return code === 0 ? gitEnv() : { ...gitEnv(), ...FALLBACK_IDENTITY }
}

/** Runs what it is given under the same key one at a time, each once the ones before it are done, failed or not. */
export function oneAtATime() {
  const queued = new Map<string, Promise<unknown>>()
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = queued.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    queued.set(key, next)
    void next.finally(() => queued.get(key) === next && queued.delete(key)).catch(() => {})
    return next
  }
}

/** Merges are one at a time per repository, so two can't both move a branch from the same commit. */
const exclusive = oneAtATime()

/**
 * Merges `head` into `base` with a merge commit, as `git merge --no-ff` does. In the worktree that has `base` checked
 * out, if there is one, that is what runs, so its files follow; otherwise (a bare repository, or `base` not checked
 * out) the same merge is made without a worktree. Refuses with `merge_conflicts`, changing nothing, when they
 * conflict, and with `merge_failed` when git refuses or can't run. When `head`'s commits are in `base` already there
 * is nothing to merge: `mergeSha` is null.
 */
export function merge(repo: string, { base, head, message }: { base: string; head: string; message: string }) {
  const merging = exclusive(repo, async () => {
    const [baseSha, headSha] = [await branchSha(repo, base), await branchSha(repo, head)]
    if (!baseSha) throw conflict('branch_missing', `The local repository has no branch "${base}"`)
    if (!headSha) throw conflict('branch_missing', `The local repository has no branch "${head}"`)
    if (await isAncestor(repo, headSha, baseSha)) return { baseSha, headSha, mergeSha: null }

    const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', baseSha, headSha]
    const tree = await git(repo, args, { codes: [0, 1] })
    const [treeSha, ...conflicted] = tree.stdout.split('\0').filter(Boolean)
    if (tree.code === 1) {
      const files = [...new Set(conflicted)]
      throw conflict(
        'merge_conflicts',
        `"${head}" can't be merged into "${base}" cleanly: they conflict in ${files.join(', ')}. Merge "${base}" into "${head}" and resolve the conflicts first.`,
        { files },
      )
    }

    const env = await commitEnv(repo)
    const worktree = await worktreeWith(repo, base)
    if (worktree) {
      // Git counts a worktree deleted without pruning as having `base` checked out still, so the board does too, as
      // it does one it can't see (outside what its Docker container mounts): `base` isn't moved behind its back.
      if (!existsSync(worktree)) {
        throw conflict(
          'merge_failed',
          `${worktree}, where "${base}" is checked out, isn't there: if it was deleted, run git worktree prune in the local repository`,
        )
      }
      const midMerge = async () => (await run(worktree, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0
      if (await midMerge()) {
        throw conflict('merge_failed', `${worktree}, where "${base}" is checked out, is in the middle of a merge`)
      }
      const result = await run(worktree, ['merge', '--no-ff', '--no-edit', '-m', message, headSha], env)
      if (result.code !== 0) {
        if (await midMerge()) await run(worktree, ['merge', '--abort'])
        throw conflict('merge_failed', `git merge in ${worktree} failed: ${(result.stderr || result.stdout).trim()}`)
      }
      const mergeSha = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()
      const parent = (await git(worktree, ['rev-parse', `${mergeSha}^1`])).stdout.trim()
      return { baseSha: parent, headSha, mergeSha }
    }

    const commit = await git(repo, ['commit-tree', treeSha.trim(), '-p', baseSha, '-p', headSha, '-m', message], {
      env,
    })
    const mergeSha = commit.stdout.trim()
    const update = await run(repo, ['update-ref', '-m', `merge ${head}`, heads(base), mergeSha, baseSha])
    if (update.code !== 0) {
      throw conflict('base_moved', `"${base}" moved while merging; try again`)
    }
    return { baseSha, headSha, mergeSha }
  })
  return merging.catch((error: unknown) => {
    // Git that couldn't run at all, in a worktree that is a file now say, rather than one that refused.
    if (error instanceof HttpError) throw error
    throw conflict('merge_failed', `Merging "${head}" into "${base}" failed: ${(error as Error).message}`)
  })
}
