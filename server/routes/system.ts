import { Hono } from 'hono'
import type { SetupStatus } from '../../shared/domain.ts'
import {
  agentLoginCodeSchema,
  reportAgentHostSchema,
  reportAgentLoginSchema,
  reportAppUpdateSchema,
  reportClaudeUsageSchema,
  reportAgentServicesSchema,
  reportDiskUsageSchema,
  requestAgentLoginSchema,
  setAgentServicesSchema,
  setGitHubTokenSchema,
  setAgentApiKeySchema,
  setUsageReserveSchema,
} from '../../shared/schemas.ts'
import type { AppServices } from '../app.ts'
import { now, transaction } from '../db.ts'
import { gitHubFailure } from '../errors.ts'
import { actorOf, readJson } from '../http.ts'
import { getAgentServices, reportAgentServices, setAgentsPaused } from '../store/agent-services.ts'
import { cancelAppUpdate, getAppUpdate, reportAppUpdate, requestAppUpdate } from '../store/app-update.ts'
import { getClaudeUsage, reportClaudeUsage, setAgentApiKey, setUsageReserve } from '../store/claude-usage.ts'
import { reportDiskUsage } from '../store/disk-usage.ts'
import {
  cancelAgentLogin,
  getAgentHost,
  getAgentLogin,
  reportAgentHost,
  reportAgentLogin,
  requestAgentLogin,
  sendAgentLoginCode,
  setStoredGitHubToken,
} from '../store/setup.ts'

/**
 * What the agent supervisor does on the host: updating and restarting ultrakanban itself (see `AppUpdate`), reading
 * how much Claude usage is left (see `ClaudeUsage`, with how much of it agents leave to people), the disk space of the
 * boards' agents (see `AgentDiskUsage`), and the agents' logins (see `AgentHost`), and switching every board's agents
 * off and on (see `AgentServices`); and the Setup page.
 */
export const systemRoutes = ({ pullRequests: { github } }: AppServices) => {
  const setupStatus = async (): Promise<SetupStatus> => ({
    github: { auth: await github.auth(), ...(await github.account()) },
    agents: getAgentHost(),
    serverTime: now(),
  })

  return (
    new Hono()
      .get('/update', (c) => c.json(getAppUpdate()))
      .post('/update', (c) =>
        c.json(
          transaction(() => requestAppUpdate(actorOf(c))),
          202,
        ),
      )
      .delete('/update', (c) => c.json(transaction(() => cancelAppUpdate())))
      .post('/update/status', async (c) => {
        const input = await readJson(c, reportAppUpdateSchema)
        return c.json(transaction(() => reportAppUpdate(input)))
      })
      .get('/claude-usage', (c) => c.json(getClaudeUsage()))
      .post('/claude-usage', async (c) => {
        const input = await readJson(c, reportClaudeUsageSchema)
        return c.json(transaction(() => reportClaudeUsage(input)))
      })
      .put('/claude-usage/reserve', async (c) => {
        const input = await readJson(c, setUsageReserveSchema)
        return c.json(transaction(() => setUsageReserve(input)))
      })
      .put('/claude-usage/api-key', async (c) => {
        const input = await readJson(c, setAgentApiKeySchema)
        return c.json(transaction(() => setAgentApiKey(input)))
      })
      .post('/disk-usage', async (c) => {
        const input = await readJson(c, reportDiskUsageSchema)
        transaction(() => reportDiskUsage(input))
        return c.body(null, 204)
      })

      .get('/setup', async (c) => c.json(await setupStatus()))
      // The token is checked with GitHub first, and never sent back.
      .put('/github-token', async (c) => {
        const { token } = await readJson(c, setGitHubTokenSchema)
        await github.verifyToken(token).catch((error: unknown) => {
          throw gitHubFailure(error)
        })
        transaction(() => setStoredGitHubToken(token))
        github.resetAuth()
        return c.json(await setupStatus())
      })
      .delete('/github-token', async (c) => {
        transaction(() => setStoredGitHubToken(null))
        github.resetAuth()
        return c.json(await setupStatus())
      })

      // The agent supervisor checking in; it answers with the login asked of it, if any.
      .post('/agents', async (c) => {
        const input = await readJson(c, reportAgentHostSchema)
        return c.json(transaction(() => reportAgentHost(input)))
      })
      .post('/agents/login', async (c) => {
        const { kind } = await readJson(c, requestAgentLoginSchema)
        return c.json(
          transaction(() => requestAgentLogin(kind)),
          202,
        )
      })
      .delete('/agents/login', (c) => c.json(transaction(() => cancelAgentLogin())))
      .post('/agents/login/code', async (c) => {
        const { code } = await readJson(c, agentLoginCodeSchema)
        return c.json(transaction(() => sendAgentLoginCode(code)))
      })
      // For the supervisor: the login it runs, with the code pasted for Claude.
      .get('/agents/login', (c) => c.json(getAgentLogin()))
      .post('/agents/login/status', async (c) => {
        const input = await readJson(c, reportAgentLoginSchema)
        return c.json(transaction(() => reportAgentLogin(input)))
      })

      .get('/agents/services', (c) => c.json(getAgentServices()))
      .put('/agents/services', async (c) => {
        const { paused, restart } = await readJson(c, setAgentServicesSchema)
        return c.json(transaction(() => setAgentsPaused(paused, actorOf(c), restart)))
      })
      // For the supervisor: the boards whose loop runs, after it started and stopped loops.
      .post('/agents/services/status', async (c) => {
        const input = await readJson(c, reportAgentServicesSchema)
        return c.json(transaction(() => reportAgentServices(input)))
      })
  )
}
