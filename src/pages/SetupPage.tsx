import { useQueryClient } from '@tanstack/react-query'
import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, ExternalLinkIcon, Loader2Icon } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { Link } from 'wouter'
import { toast } from 'sonner'
import type { AgentHost, AgentLoginKind, SetupStatus } from '@shared/domain'
import { AppHeader } from '@/components/app/AppHeader'
import { CopyButton } from '@/components/common/CopyButton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { queryKeys, useBoards, useSetup } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { api, errorMessage } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/** GitHub's page for a classic token, with the scopes the board and the agents need ticked. */
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=ultrakanban'

/** The supervisor checks in every 30 seconds; after this long without it, it isn't running. */
const AGENTS_OFFLINE_MS = 3 * 60_000

const AUTH_SOURCES = { board: 'the token set here', env: 'GITHUB_TOKEN', gh: 'the GitHub CLI’s login' }

type StepState = 'done' | 'todo' | 'problem' | 'later'

function Step({
  state,
  title,
  status,
  children,
}: {
  state: StepState
  title: string
  status: ReactNode
  children?: ReactNode
}) {
  const Icon = state === 'done' ? CircleCheckIcon : state === 'problem' ? CircleAlertIcon : CircleDashedIcon
  return (
    <section className="flex gap-3 rounded-xl border bg-card p-4">
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          state === 'done' && 'text-emerald-600 dark:text-emerald-400',
          state === 'problem' && 'text-amber-600 dark:text-amber-400',
          (state === 'todo' || state === 'later') && 'text-muted-foreground',
        )}
      />
      <div className={cn('grid min-w-0 flex-1 gap-2', state === 'later' && 'opacity-60')}>
        <div className="grid gap-0.5">
          <h2 className="text-sm font-medium">{title}</h2>
          <div className="text-sm text-muted-foreground">{status}</div>
        </div>
        {children}
      </div>
    </section>
  )
}

function Command({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-1 rounded-md border bg-muted/50 py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">{children}</code>
      <CopyButton getText={() => children} label="Copy command" />
    </div>
  )
}

function GitHubTokenForm({ status, onChange }: { status: SetupStatus; onChange: (status: SetupStatus) => void }) {
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(!status.github.login)

  const save = async (request: Promise<SetupStatus>) => {
    setSaving(true)
    try {
      const next = await request
      onChange(next)
      setToken('')
      setOpen(!next.github.login)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (token.trim()) void save(api.setGitHubToken(token.trim()))
  }

  if (!open) {
    return (
      <div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Use another token
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        {status.github.login ? 'To use another token, ' : ''}
        <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
          create a classic token on GitHub
        </a>{' '}
        (the repo, read:org and workflow scopes are already ticked) and paste it here. It is kept in the board’s
        database and never shown again.
      </p>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          placeholder="ghp_…"
          aria-label="GitHub token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Button type="submit" disabled={saving || !token.trim()}>
          Save
        </Button>
        {status.github.auth === 'board' && (
          <Button type="button" variant="outline" disabled={saving} onClick={() => save(api.removeGitHubToken())}>
            Remove
          </Button>
        )}
      </div>
    </form>
  )
}

/** Runs `gh auth login` or `claude auth login` where the agents run, through the agent supervisor. */
function AgentLogin({
  kind,
  agents,
  online,
  loggedIn,
}: {
  kind: AgentLoginKind
  agents: AgentHost
  online: boolean
  loggedIn: boolean
}) {
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const login = agents.login?.kind === kind ? agents.login : null
  const running = login && (login.state === 'requested' || login.state === 'waiting' || login.state === 'checking')
  const name = kind === 'github' ? 'GitHub' : 'Claude'

  const send = async (request: Promise<AgentHost>) => {
    setSending(true)
    try {
      const host = await request
      queryClient.setQueryData<SetupStatus>(queryKeys.setup, (status) => status && { ...status, agents: host })
      return true
    } catch (error) {
      toast.error(errorMessage(error))
      return false
    } finally {
      setSending(false)
    }
  }
  const submitCode = async (event: FormEvent) => {
    event.preventDefault()
    if (code.trim() && (await send(api.sendAgentLoginCode(code.trim())))) setCode('')
  }

  if (!running) {
    return (
      <div className="grid gap-2">
        {login?.state === 'failed' && (
          <p className="text-xs break-words text-destructive">The last login failed: {login.message}</p>
        )}
        <div>
          <Button
            size="sm"
            variant={loggedIn ? 'outline' : 'default'}
            disabled={sending || !online}
            onClick={() => send(api.requestAgentLogin(kind))}
          >
            {loggedIn ? `Log in to ${name} again` : `Log in to ${name}`}
          </Button>
        </div>
      </div>
    )
  }

  let body: ReactNode
  if (login.state === 'requested') {
    body = <Waiting>Waiting for the agent supervisor to start the login…</Waiting>
  } else if (login.state === 'checking' || login.codeSent) {
    body = <Waiting>Finishing the login…</Waiting>
  } else if (kind === 'github') {
    body = (
      <>
        <p className="text-sm">Open GitHub’s device page and enter this code:</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border bg-muted/50 px-3 py-1 font-mono text-lg tracking-widest">
            {login.userCode}
          </span>
          <CopyButton getText={() => login.userCode ?? ''} label="Copy code" />
          <Button asChild size="sm">
            <a href={login.url ?? 'https://github.com/login/device'} target="_blank" rel="noreferrer">
              Open github.com/login/device
              <ExternalLinkIcon />
            </a>
          </Button>
        </div>
        <Waiting>Waiting for you to approve it on GitHub…</Waiting>
      </>
    )
  } else {
    body = (
      <>
        <p className="text-sm">Sign in to Claude, then paste the code it shows here.</p>
        <div>
          <Button asChild size="sm">
            <a href={login.url ?? '#'} target="_blank" rel="noreferrer">
              Open Claude’s sign-in page
              <ExternalLinkIcon />
            </a>
          </Button>
        </div>
        <form onSubmit={submitCode} className="flex gap-2">
          <Input
            autoComplete="off"
            placeholder="Code from Claude"
            aria-label="Code from Claude"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" disabled={sending || !code.trim()}>
            Send
          </Button>
        </form>
      </>
    )
  }

  return (
    <div className="grid gap-2 rounded-lg border p-3">
      {body}
      <div>
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => send(api.cancelAgentLogin())}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
      {children}
    </p>
  )
}

function StartAgents() {
  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <p>
        Start them from the folder you cloned ultrakanban into. On Linux, as services on this machine, which need Claude
        Code (the <code>claude</code> command), gh and jq installed:
      </p>
      <Command>npm install -g @anthropic-ai/claude-code</Command>
      <Command>scripts/setup.sh --agents</Command>
      <p>On Windows and macOS (or Linux, if you’d rather), in a container:</p>
      <Command>docker compose --profile agents up -d --build</Command>
      <p>They check in here within a minute.</p>
    </div>
  )
}

export function SetupPage() {
  const queryClient = useQueryClient()
  const { data: status, error } = useSetup()
  const { data: boards } = useBoards()
  const now = useNow(10_000)

  useEffect(() => {
    document.title = 'Setup · ultrakanban'
  }, [])

  // A finished login shows up in the supervisor's next check-in, a few seconds later.
  const loginState = status?.agents.login?.state
  useEffect(() => {
    if (loginState === 'done') void queryClient.invalidateQueries({ queryKey: queryKeys.setup })
  }, [loginState, queryClient])

  let content: ReactNode = null
  if (error) {
    content = <p className="text-sm text-muted-foreground">Couldn’t load the setup: {error.message}</p>
  } else if (status) {
    const { github, agents } = status
    const online = !!agents.seenAt && now - Date.parse(agents.seenAt) < AGENTS_OFFLINE_MS
    const where = agents.runsIn === 'container' ? 'in the agents container' : 'on this machine'
    const later = online ? 'todo' : 'later'
    const boardWithAgent = boards?.find((board) => board.agentEnabled && board.githubRepo)
    const setUp = (next: SetupStatus) => {
      queryClient.setQueryData(queryKeys.setup, next)
      void queryClient.invalidateQueries({ queryKey: queryKeys.github })
    }

    content = (
      <div className="grid gap-3">
        <Step
          state={github.login ? 'done' : github.auth ? 'problem' : 'todo'}
          title="Connect the board to GitHub"
          status={
            github.login ? (
              <>
                Following pull requests as <strong className="text-foreground">{github.login}</strong>, with{' '}
                {AUTH_SOURCES[github.auth!]}.
              </>
            ) : github.auth ? (
              <>
                GitHub turned down {AUTH_SOURCES[github.auth]}: {github.error}
              </>
            ) : (
              <>
                The board needs a GitHub token to follow pull requests, merge them and create repositories.
                {online && ' Logging the agents in to GitHub below gives it theirs, or paste one here.'}
              </>
            )
          }
        >
          <GitHubTokenForm status={status} onChange={setUp} />
        </Step>

        <Step
          state={online ? 'done' : agents.seenAt ? 'problem' : 'todo'}
          title="Start the agents"
          status={
            online
              ? `Running ${where}; checked in ${formatRelative(agents.seenAt!)}.`
              : agents.seenAt
                ? `They last checked in ${formatRelative(agents.seenAt)}, ${where}. Start them again:`
                : 'The agents work tickets on boards that have them switched on. They aren’t running yet.'
          }
        >
          {!online && <StartAgents />}
        </Step>

        <Step
          state={agents.githubLogin ? 'done' : later}
          title="Log the agents in to GitHub"
          status={
            agents.githubLogin ? (
              <>
                Logged in as <strong className="text-foreground">{agents.githubLogin}</strong>. They clone, push and
                open pull requests with it.
              </>
            ) : (
              <>
                They clone, push and open pull requests with it.
                {!github.auth && ' This also connects the board to GitHub, if it isn’t yet.'}
              </>
            )
          }
        >
          <AgentLogin kind="github" agents={agents} online={online} loggedIn={!!agents.githubLogin} />
        </Step>

        <Step
          state={agents.claudeAccount ? 'done' : later}
          title="Log the agents in to Claude"
          status={
            agents.claudeAccount ? (
              <>
                Logged in
                {agents.claudeAccount === 'token' ? (
                  ' with CLAUDE_CODE_OAUTH_TOKEN'
                ) : agents.claudeAccount !== 'logged in' ? (
                  <>
                    {' '}
                    as <strong className="text-foreground">{agents.claudeAccount}</strong>
                  </>
                ) : null}
                . Their runs use your Claude plan.
              </>
            ) : (
              'Their runs use your Claude plan (Pro or Max) or Console account.'
            )
          }
        >
          {agents.claudeAccount !== 'token' && (
            <AgentLogin kind="claude" agents={agents} online={online} loggedIn={!!agents.claudeAccount} />
          )}
        </Step>

        {agents.seenAt && (
          <Step
            state={agents.gitIdentity ? 'done' : later}
            title="Commit name and email"
            status={
              agents.gitIdentity
                ? `The agents commit as ${agents.gitIdentity}.`
                : 'git has no name and email to commit with. Logging the agents in to GitHub sets them to your GitHub account’s.'
            }
          />
        )}

        <Step
          state={boardWithAgent ? 'done' : 'todo'}
          title="Switch the agent on for a board"
          status={
            boardWithAgent ? (
              <>
                The agent works{' '}
                <Link href={`/b/${boardWithAgent.id}`} className="text-foreground underline underline-offset-2">
                  {boardWithAgent.name}
                </Link>{' '}
                on {boardWithAgent.githubRepo}. Switch it on for other boards the same way.
              </>
            ) : (
              <>
                On a board, open <strong className="text-foreground">Board menu → Board settings</strong>, set its
                GitHub repository (or create one there) and switch on{' '}
                <strong className="text-foreground">Run the agent on this board</strong>. It then claims the board’s
                Todo tickets.
              </>
            )
          }
        >
          {!boards?.length && (
            <div>
              <Button asChild size="sm" variant="outline">
                <Link href="/">Create a board</Link>
              </Button>
            </div>
          )}
        </Step>
      </div>
    )
  }

  return (
    <>
      <AppHeader />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-2xl grid-cols-1 gap-5 p-4 sm:p-6">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Setup</h1>
            <p className="text-sm text-muted-foreground">
              Connect GitHub and Claude, so the board can follow pull requests and the agents can work your tickets.
            </p>
          </div>
          {content}
        </div>
      </main>
    </>
  )
}
