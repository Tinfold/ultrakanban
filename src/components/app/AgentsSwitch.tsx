import { useQueryClient } from '@tanstack/react-query'
import { BotIcon, Loader2Icon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentsSwitching, queryKeys, useAgentServices } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { api, errorMessage } from '@/lib/api'
import { formatRelative } from '@/lib/format'

/** The supervisor reports every 30 seconds; after this long without it, nothing starts or stops the agents. */
const SUPERVISOR_OFFLINE_MS = 3 * 60_000

const boards = (count: number) => `${count} board${count === 1 ? '' : 's'}`

/**
 * Every board's agents at once: green while each board whose agent is on has its loop running, a warning otherwise.
 * Clicking it stops them all (with the containers their runs use), or starts them again. The agent supervisor does it on
 * the host, so this shows once it has reported.
 */
export function AgentsSwitch() {
  const queryClient = useQueryClient()
  const { data: services } = useAgentServices()
  const now = useNow()
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  if (!services?.reportedAt) return null

  const offline = now - Date.parse(services.reportedAt) > SUPERVISOR_OFFLINE_MS
  const switching = !offline && agentsSwitching(services)
  const missing = services.wanted.filter((id) => !services.running.includes(id)).length
  const up = !services.paused && !offline && missing === 0

  const status = offline
    ? `The agent supervisor last reported ${formatRelative(services.reportedAt)}, so nothing starts or stops the agents. Start it with: systemctl --user start ultrakanban-agent`
    : switching
      ? services.paused
        ? 'Stopping the agents…'
        : 'Starting the agents…'
      : services.paused
        ? 'Agents are switched off. Click to start them.'
        : missing > 0
          ? `Agents aren’t running on ${missing} of ${boards(services.wanted.length)}. Click to start them.`
          : `Agents are running on ${boards(services.wanted.length)}. Click to stop them.`

  const switchTo = async (paused: boolean) => {
    setSending(true)
    try {
      queryClient.setQueryData(queryKeys.agentServices, await api.setAgentsPaused(paused))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={up ? 'Stop the agents' : 'Start the agents'}
            disabled={switching || sending}
            onClick={() => (offline ? toast.error(status) : setConfirming(true))}
          >
            {switching ? (
              <Loader2Icon className="animate-spin" />
            ) : up ? (
              <BotIcon className="text-emerald-600 dark:text-emerald-400" />
            ) : (
              <TriangleAlertIcon className="text-destructive" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{status}</TooltipContent>
      </Tooltip>
      {up ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Stop all agents?"
          description="Every board's agent loop stops, along with the containers their runs use, and none starts until you start them again here. Runs in progress stop too, and carry on where they left off once the agents are back. The board itself keeps running."
          confirmLabel="Stop agents"
          onConfirm={() => switchTo(true)}
        />
      ) : (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Start the agents?"
          description={`This starts the agent loop of every board whose agent is on (${boards(services.wanted.length)}), and the containers their runs use. They claim tickets and use your Claude plan right away.`}
          confirmLabel="Start agents"
          onConfirm={() => switchTo(false)}
        />
      )}
    </>
  )
}
