import type { AgentHost, AgentLogin, AgentLoginKind, AgentLoginState } from '../../shared/domain.ts'
import type { ReportAgentHostInput, ReportAgentLoginInput } from '../../shared/schemas.ts'
import { now, sql } from '../db.ts'
import { conflict } from '../errors.ts'

interface SetupRow {
  github_token: string | null
  agents_seen_at: string | null
  agents_run_in: AgentHost['runsIn']
  agents_github_login: string | null
  agents_claude_account: string | null
  agents_git_identity: string | null
  login_kind: AgentLoginKind | null
  login_state: AgentLoginState | null
  login_requested_at: string | null
  login_url: string | null
  login_user_code: string | null
  login_code: string | null
  login_message: string | null
  login_updated_at: string | null
}

/** GitHub's device codes and Claude's sign-in links expire after 15 minutes, and the supervisor gives up then too. */
export const AGENT_LOGIN_TIMEOUT_MS = 15 * 60_000

const getRow = () => sql.get<SetupRow>('SELECT * FROM setup WHERE id = 1')!

/** The supervisor's view of a login: with the code pasted for Claude, which only it reads. */
export type SupervisorAgentLogin = AgentLogin & { code: string | null }

function toLogin(row: SetupRow): AgentLogin | null {
  if (!row.login_kind || !row.login_state) return null
  return {
    kind: row.login_kind,
    state: row.login_state,
    requestedAt: row.login_requested_at!,
    url: row.login_url,
    userCode: row.login_user_code,
    codeSent: row.login_code !== null,
    message: row.login_message,
    updatedAt: row.login_updated_at!,
  }
}

const active = (login: AgentLogin | null, time = Date.now()) =>
  !!login &&
  (login.state === 'requested' || login.state === 'waiting' || login.state === 'checking') &&
  time - Date.parse(login.requestedAt) < AGENT_LOGIN_TIMEOUT_MS

export function getAgentLogin(): SupervisorAgentLogin | null {
  const row = getRow()
  const login = toLogin(row)
  return login && { ...login, code: row.login_code }
}

export function getAgentHost(): AgentHost {
  const row = getRow()
  return {
    seenAt: row.agents_seen_at,
    runsIn: row.agents_run_in,
    githubLogin: row.agents_github_login,
    claudeAccount: row.agents_claude_account,
    gitIdentity: row.agents_git_identity,
    login: toLogin(row),
  }
}

/** The GitHub token set on the Setup page; the API never sends it back. */
export const getStoredGitHubToken = () => getRow().github_token

export function setStoredGitHubToken(token: string | null) {
  sql.run('UPDATE setup SET github_token = ? WHERE id = 1', token)
}

export function reportAgentHost(input: ReportAgentHostInput): AgentHost {
  sql.run(
    `UPDATE setup SET agents_seen_at = ?, agents_run_in = ?, agents_github_login = ?, agents_claude_account = ?,
     agents_git_identity = ? WHERE id = 1`,
    now(),
    input.runsIn,
    input.githubLogin ?? null,
    input.claudeAccount ?? null,
    input.gitIdentity ?? null,
  )
  return getAgentHost()
}

/** Asks the supervisor to run a login; one at a time, unless the last one has run out of time. */
export function requestAgentLogin(kind: AgentLoginKind): AgentHost {
  if (active(getAgentLogin())) throw conflict('login_in_progress', 'A login is already running; cancel it first')
  const time = now()
  sql.run(
    `UPDATE setup SET login_kind = ?, login_state = 'requested', login_requested_at = ?, login_url = NULL,
     login_user_code = NULL, login_code = NULL, login_message = NULL, login_updated_at = ? WHERE id = 1`,
    kind,
    time,
    time,
  )
  return getAgentHost()
}

/** Stops a login: the supervisor stops its command once it sees it gone. */
export function cancelAgentLogin(): AgentHost {
  sql.run(
    `UPDATE setup SET login_kind = NULL, login_state = NULL, login_requested_at = NULL, login_url = NULL,
     login_user_code = NULL, login_code = NULL, login_message = NULL, login_updated_at = NULL WHERE id = 1`,
  )
  return getAgentHost()
}

/** Claude's code, from its sign-in page, for the `claude auth login` the supervisor is running. */
export function sendAgentLoginCode(code: string): AgentHost {
  const login = getAgentLogin()
  if (!active(login) || login!.kind !== 'claude' || login!.state !== 'waiting') {
    throw conflict('login_not_waiting', 'No Claude login is waiting for a code; start one again')
  }
  sql.run('UPDATE setup SET login_code = ?, login_updated_at = ? WHERE id = 1', code, now())
  return getAgentHost()
}

/**
 * The supervisor reporting on the login it runs: `waiting` takes a request (409 `login_not_requested` when there is
 * none, e.g. it was cancelled) and later says what to show; `checking` takes the pasted code; `done` and `failed` end it.
 * Anything but a running login is a 409, so the supervisor stops its command.
 */
export function reportAgentLogin(input: ReportAgentLoginInput): SupervisorAgentLogin {
  const login = getAgentLogin()
  if (!login || !active(login) || (input.state === 'waiting' && login.state === 'checking')) {
    throw conflict('login_not_requested', 'No login is asked for')
  }
  sql.run(
    `UPDATE setup SET login_state = ?, login_url = ?, login_user_code = ?, login_message = ?, login_updated_at = ?,
     login_code = CASE WHEN ? = 'checking' THEN NULL ELSE login_code END WHERE id = 1`,
    input.state,
    input.url === undefined ? login.url : input.url,
    input.userCode === undefined ? login.userCode : input.userCode,
    input.message === undefined ? login.message : input.message,
    now(),
    input.state,
  )
  return getAgentLogin()!
}
