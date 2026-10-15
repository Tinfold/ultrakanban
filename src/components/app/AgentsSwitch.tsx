import { useQueryClient } from '@tanstack/react-query'
import { BotIcon, Loader2Icon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { queryKeys, useAgentServices, useBoards } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { agentsSwitchState } from '@/lib/agents-switch'
import { api, errorMessage } from '@/lib/api'
import type { AgentServices } from '@shared/domain'
import { formatRelative } from '@/lib/format'

const boards = (count: number) => `${count} board${count === 1 ? '' : 's'}`
const list = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * Every board's agents at once: green while each board whose agent is on has its loop running and claiming tickets, a
 * warning otherwise. Clicking it stops them all (with the containers their runs use), or starts them again; while they
 * are on, it starts the boards' loops that stopped now, rather than after the supervisor's wait between retries, and
 * while a loop runs but can't claim a ticket, it can also restart them all. The agent supervisor does it on the host, so
 * this shows once it has reported. On a board whose agent is on, stopping them stops that board's agent by default, as
 * switching it off in its settings does, and the others' only if asked.
 */
export function AgentsSwitch({ boardId }: { boardId?: string }) {
  const queryClient = useQueryClient()
  const { data: services, dataUpdatedAt } = useAgentServices()
  const { data: boardList } = useBoards()
  const now = useNow()
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  if (!services?.reportedAt) return null

  // The server's time now: it stamped the report, and its clock can be off from this browser's (see the Setup page).
  const serverNow = Math.max(now, dataUpdatedAt) + Date.parse(services.serverTime) - dataUpdatedAt
  const state = agentsSwitchState(services, serverNow, (id) => boardList?.find((board) => board.id === id)?.name)
  const up = state.kind === 'up'
  // The board on screen, if its agent is on: stopping the agents stops its own by default.
  const board = boardId && services.wanted.includes(boardId) ? boardList?.find(({ id }) => id === boardId) : undefined

  let status: string
  switch (state.kind) {
    case 'offline':
      status = `The agent supervisor last reported ${formatRelative(services.reportedAt)}, so nothing starts or stops the agents. Start it with: systemctl --user start ultrakanban-agent`
      break
    case 'switching':
      status = state.paused ? 'Stopping the agents…' : state.restart ? 'Restarting the agents…' : 'Starting the agents…'
      break
    case 'paused':
      status = 'Agents are switched off. Click to start them.'
      break
    case 'missing':
      status = `Agents aren’t running on ${list(state.boards)}. The supervisor starts them again after a wait; click to start them now.`
      break
    case 'failing':
      status = `Agents are running, but can’t take any ticket: ${state.boards
        .map(({ name, message }) => `on ${name}, ${message}`)
        .join('; ')}. Click to stop or restart them.`
      break
    case 'up':
      status = !state.boards
        ? 'Agents are on, but no board has its agent switched on. Click to switch them off.'
        : board
          ? `Agents are running on ${boards(state.boards)}. Click to stop the agent on ${board.name}, or all of them.`
          : `Agents are running on ${boards(state.boards)}. Click to stop them.`
  }

  const send = async (request: () => Promise<AgentServices>) => {
    setSending(true)
    try {
      queryClient.setQueryData(queryKeys.agentServices, await request())
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSending(false)
    }
  }
  const switchTo = (paused: boolean) => send(() => api.setAgentsPaused(paused))
  // The supervisor stops the loop of a board whose agent is switched off, as it does every loop when they are paused.
  const stopBoard = (id: string) =>
    send(async () => {
      await api.updateBoard(id, { agentEnabled: false })
      void queryClient.invalidateQueries({ queryKey: queryKeys.board(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.boards })
      return api.agentServices()
    })

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              up ? 'Stop the agents' : state.kind === 'failing' ? 'Stop or restart the agents' : 'Start the agents'
            }
            disabled={state.kind === 'switching' || sending}
            onClick={() => (state.kind === 'offline' ? toast.error(status) : setConfirming(true))}
          >
            {state.kind === 'switching' ? (
              <Loader2Icon className="animate-spin" />
            ) : up ? (
              <BotIcon className="text-emerald-600 dark:text-emerald-400" />
            ) : state.kind === 'failing' ? (
              <TriangleAlertIcon className="text-amber-600 dark:text-amber-400" />
            ) : (
              <TriangleAlertIcon className="text-destructive" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{status}</TooltipContent>
      </Tooltip>
      {up && board ? (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop the agent on {board.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Its agent loop stops, along with the containers its runs use, and its agent is switched off: switch it
                on again in Board settings. Runs in progress stop too, and carry on where they left off once it is back.
                The other boards' agents keep running; stopping all of them switches every board's agents off until you
                start them again here.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="outline" onClick={() => switchTo(true)}>
                Stop all
              </AlertDialogAction>
              <AlertDialogAction variant="destructive" onClick={() => stopBoard(board.id)}>
                Stop this board
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : up ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Stop all agents?"
          description="Every board's agent loop stops, along with the containers their runs use, and none starts until you start them again here. Runs in progress stop too, and carry on where they left off once the agents are back. The board itself keeps running."
          confirmLabel="Stop agents"
          onConfirm={() => switchTo(true)}
        />
      ) : state.kind === 'failing' ? (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Agents can’t take any ticket</AlertDialogTitle>
              <AlertDialogDescription>
                Their loops run, but claiming a ticket fails, so no run starts:
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
              {state.boards.map(({ name, message, since }) => (
                <li key={name}>
                  <span className="text-foreground font-medium">{name}</span>: {message} (since {formatRelative(since)})
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-sm">
              Fix the board (a missing column, say) and the next claim, within a minute, clears this. Restarting stops
              every board's agent loop, along with the containers their runs use, and starts them again. Stopping
              switches them off until you start them again here.
            </p>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => switchTo(true)}>
                Stop agents
              </AlertDialogAction>
              <AlertDialogAction onClick={() => send(api.restartAgents)}>Restart agents</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : state.kind === 'missing' ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Start the stopped agents now?"
          description={`The agent loop of ${list(state.boards)} isn't running, and the supervisor starts it again after a wait. This starts it now instead. If it keeps stopping, its log says why: journalctl --user -u 'ultrakanban-agent@*'`}
          confirmLabel="Start now"
          onConfirm={() => switchTo(false)}
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
