import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { serve, type ServerType } from '@hono/node-server'
import type { SupervisorAgentLogin } from './store/setup.ts'
import { app, call } from './test-app.ts'

/**
 * The Setup page's logins as agent-supervisor.sh runs them: its own functions, under its own `set` options, against this
 * API, with fake `gh` and `claude` commands. The supervisor's main loop isn't run: it would look after real services.
 */
const script = readFileSync(new URL('../scripts/agent-supervisor.sh', import.meta.url), 'utf8')
const fromScript = (pattern: RegExp) => {
  const found = script.match(pattern)
  assert.ok(found, `agent-supervisor.sh has no ${pattern}`)
  return found[0]
}
const functionOf = (name: string) => fromScript(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'))

const fakeGh = `#!/bin/sh
case "$1 $2" in
  'auth login')
    echo '! One-time code (ABCD-1234) copied to clipboard'
    echo 'Open this URL to continue in your web browser: https://github.com/login/device'
    until [ -e "$HOME/approved" ]; do sleep 0.1; done
    ;;
  'api user') echo octocat ;;
esac
`
const fakeClaude = `#!/bin/sh
if [ "$1 $2" = 'auth status' ]; then
  echo '{"loggedIn":true,"email":"me@example.com"}'
  exit
fi
echo 'Use the url below to sign in: https://claude.ai/oauth/authorize?code=true'
read -r code
printf '%s' "$code" >"$HOME/code"
`

describe('The agent supervisor running a login', () => {
  let server: ServerType
  let kanban: string
  let home: string
  let bin: string

  before(async () => {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        kanban = `http://127.0.0.1:${info.port}`
        resolve()
      })
    })
  })
  after(() => void server.close())

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ultrakanban-agent-login-'))
    bin = join(home, 'bin')
    mkdirSync(bin)
    for (const [name, content] of [
      ['gh', fakeGh],
      ['claude', fakeClaude],
    ] as const) {
      writeFileSync(join(bin, name), content)
      chmodSync(join(bin, name), 0o755)
    }
    await call('DELETE', '/system/agents/login')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  /** Runs start_login as the supervisor does and resolves once the login is over; `extra` is bash to run before it. */
  const startLogin = (extra = '') => {
    const bash = [
      fromScript(/^set -.*$/m),
      `KANBAN=${kanban}`,
      'login_pid=',
      // Its polls don't need the seconds they wait in earnest.
      'sleep() { command sleep 0.05; }',
      ...['start_login', 'login_died', 'login_report', 'run_login', 'after_github_login'].map(functionOf),
      extra,
      'start_login',
      'wait "$login_pid"',
    ].join('\n')
    return new Promise<string>((resolve, reject) => {
      // Its own environment, as it sets git up for the login: the HOME here has the only git config it can write to.
      const child = spawn('bash', ['-c', bash], {
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, 'config') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (data) => (output += data))
      child.stderr.on('data', (data) => (output += data))
      child.on('error', reject)
      child.on('close', () => resolve(output))
    })
  }

  const login = async () => (await call<SupervisorAgentLogin>('GET', '/system/agents/login')).body
  const until = async (state: SupervisorAgentLogin['state']) => {
    for (let i = 0; i < 200; i++) {
      const current = await login()
      if (current.state === state) return current
      assert.ok(current.state !== 'failed', `The login failed: ${current.message}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.fail(`The login never got to ${state}: ${JSON.stringify(await login())}`)
  }

  test('shows GitHub’s code, and finishes once it is approved', async () => {
    await call('POST', '/system/agents/login', { kind: 'github' })
    const running = startLogin()

    const waiting = await until('waiting')
    assert.equal(waiting.userCode, 'ABCD-1234')
    assert.equal(waiting.url, 'https://github.com/login/device')

    writeFileSync(join(home, 'approved'), '')
    const output = await running
    const done = await login()
    assert.equal(done.state, 'done', output)
    assert.equal(done.message, 'Logged in to GitHub as octocat.')
    assert.doesNotMatch(output, /unbound variable/)
  })

  test('shows Claude’s link, and gives claude the code pasted on the page', async () => {
    await call('POST', '/system/agents/login', { kind: 'claude' })
    const running = startLogin()

    const waiting = await until('waiting')
    assert.equal(waiting.url, 'https://claude.ai/oauth/authorize?code=true')
    assert.equal((await call('POST', '/system/agents/login/code', { code: 'the-code' })).status, 200)

    const output = await running
    const done = await login()
    assert.equal(done.state, 'done', output)
    assert.equal(done.message, 'Logged in to Claude as me@example.com.')
    assert.equal(readFileSync(join(home, 'code'), 'utf8'), 'the-code')
    assert.doesNotMatch(output, /unbound variable/)
  })

  test('says so when the login dies without reporting, rather than leaving the page waiting', async () => {
    await call('POST', '/system/agents/login', { kind: 'github' })

    const output = await startLogin('run_login() { local unset; [[ -n $unset ]]; }')

    assert.match(output, /unset: unbound variable/)
    const failed = await login()
    assert.equal(failed.state, 'failed')
    assert.match(failed.message ?? '', /stopped unexpectedly/)
  })

  test('reports nothing for a login that returned, even with a failing status', async () => {
    await call('POST', '/system/agents/login', { kind: 'github' })

    await startLogin('run_login() { return 1; }')

    assert.equal((await login()).state, 'requested')
  })
})
