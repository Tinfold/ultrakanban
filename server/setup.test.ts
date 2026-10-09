import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentHost, SetupStatus } from '../shared/domain.ts'
import type { SupervisorAgentLogin } from './store/setup.ts'
import { call, github } from './test-app.ts'

describe('Setup', () => {
  const setup = async () => (await call<SetupStatus>('GET', '/system/setup')).body
  const checkIn = (body: Record<string, unknown> = { runsIn: 'container' }) =>
    call<AgentHost>('POST', '/system/agents', body, 'agent-supervisor')
  const report = (body: Record<string, unknown>) =>
    call<SupervisorAgentLogin>('POST', '/system/agents/login/status', body, 'agent-supervisor')

  test('takes a GitHub token for the board, checked with GitHub and never sent back', async () => {
    github.auth = null
    assert.deepEqual((await setup()).github, { auth: null, login: null, error: 'No GitHub token' })

    const refused = await call('PUT', '/system/github-token', { token: 'bad' })
    assert.equal(refused.status, 400)
    assert.equal((await setup()).github.auth, null)

    const set = await call<SetupStatus>('PUT', '/system/github-token', { token: 'ghp_good' })
    assert.equal(set.status, 200)
    assert.deepEqual(set.body.github, { auth: 'board', login: 'octocat', error: null })
    assert.ok(!JSON.stringify(await setup()).includes('ghp_good'))
    assert.equal((await call<{ auth: string }>('GET', '/github')).body.auth, 'board')

    assert.equal((await call<SetupStatus>('DELETE', '/system/github-token')).body.github.auth, null)
    github.auth = 'env'
  })

  test('shows what the agent supervisor last reported', async () => {
    assert.equal((await setup()).agents.seenAt, null)
    const reported = await checkIn({
      runsIn: 'machine',
      githubLogin: 'octocat',
      claudeAccount: 'me@example.com',
      gitIdentity: 'Octo Cat <octocat@example.com>',
    })
    assert.equal(reported.status, 200)
    const { agents, serverTime } = await setup()
    assert.ok(agents.seenAt)
    // The page judges the check-in by the server's clock, which can be off from the browser's.
    assert.ok(Date.parse(serverTime) >= Date.parse(agents.seenAt))
    assert.deepEqual(
      [agents.runsIn, agents.githubLogin, agents.claudeAccount, agents.gitIdentity, agents.login],
      ['machine', 'octocat', 'me@example.com', 'Octo Cat <octocat@example.com>', null],
    )
    assert.equal((await checkIn({ runsIn: 'somewhere' })).status, 400)
  })

  test('relays a Claude login: the sign-in link to the page, the code back to the supervisor', async () => {
    assert.equal((await report({ state: 'waiting' })).status, 409)

    const requested = await call<AgentHost>('POST', '/system/agents/login', { kind: 'claude' })
    assert.equal(requested.status, 202)
    assert.equal(requested.body.login?.state, 'requested')
    assert.equal((await checkIn()).body.login?.kind, 'claude')
    assert.equal((await call('POST', '/system/agents/login', { kind: 'github' })).status, 409)
    // No code before the supervisor has shown the link.
    assert.equal((await call('POST', '/system/agents/login/code', { code: 'abc' })).status, 409)

    const url = 'https://claude.com/cai/oauth/authorize?code=true'
    assert.equal((await report({ state: 'waiting', url })).body.url, url)
    const sent = await call<AgentHost>('POST', '/system/agents/login/code', { code: 'abc#state' })
    assert.deepEqual([sent.body.login?.codeSent, 'code' in sent.body.login!], [true, false])
    assert.equal((await call<SupervisorAgentLogin>('GET', '/system/agents/login')).body.code, 'abc#state')

    const checking = await report({ state: 'checking' })
    assert.deepEqual([checking.body.code, checking.body.codeSent], [null, false])
    assert.equal((await report({ state: 'waiting' })).status, 409)
    assert.equal((await report({ state: 'done', message: 'Logged in as me@example.com' })).body.state, 'done')
    // Over: the supervisor's reports are turned down, and a new login can be asked for.
    assert.equal((await report({ state: 'failed' })).status, 409)
    assert.equal((await call('POST', '/system/agents/login', { kind: 'github' })).status, 202)
  })

  test('cancelling a login stops the supervisor reporting on it', async () => {
    await call('DELETE', '/system/agents/login')
    await call('POST', '/system/agents/login', { kind: 'github' })
    const waiting = await report({ state: 'waiting', url: 'https://github.com/login/device', userCode: 'B8BA-9179' })
    assert.equal(waiting.body.userCode, 'B8BA-9179')
    // GitHub's login takes no code from the page.
    assert.equal((await call('POST', '/system/agents/login/code', { code: 'abc' })).status, 409)

    assert.equal((await call<AgentHost>('DELETE', '/system/agents/login')).body.login, null)
    assert.equal((await report({ state: 'done' })).status, 409)
    assert.equal((await call('GET', '/system/agents/login')).body, null)
  })
})
