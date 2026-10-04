import { useQueryClient } from '@tanstack/react-query'
import { CircleArrowUpIcon, Loader2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { AppUpdate } from '@shared/domain'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { queryKeys, useAppUpdate } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { api, errorMessage } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The supervisor checks in every 30 seconds; after this long without it, nothing would act on a request soon. */
const UPDATER_OFFLINE_MS = 3 * 60_000

const loadedAt = new Date().toISOString()

function UpdateStatus({ update }: { update: AppUpdate }) {
  switch (update.state) {
    case 'requested':
      return <p className="text-xs text-muted-foreground">Waiting for the agent supervisor to start the update…</p>
    case 'running':
      return (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          Updating. The board restarts and is unreachable for a minute or so.
        </p>
      )
    case 'done':
      return (
        <p className="text-xs text-muted-foreground">
          {update.message ?? 'Updated'} {update.finishedAt && formatRelative(update.finishedAt)}.
        </p>
      )
    case 'failed':
      return (
        <p className="text-xs break-words text-destructive">
          The last update failed{update.finishedAt && ` ${formatRelative(update.finishedAt)}`}: {update.message}
        </p>
      )
    default:
      return null
  }
}

/**
 * Updates and restarts ultrakanban: the agent supervisor on the host pulls the latest default branch and rebuilds the
 * board. Shown once a supervisor has checked in, since nothing else would act on the request.
 */
export function UpdateMenu() {
  const queryClient = useQueryClient()
  const { data: update } = useAppUpdate()
  const now = useNow()
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  if (!update?.updaterSeenAt) return null

  const busy = update.state === 'requested' || update.state === 'running'
  const offline = now - Date.parse(update.updaterSeenAt) > UPDATER_OFFLINE_MS
  const behind = update.behind ?? 0
  // Finished since this page loaded, so it runs the old build until reloaded.
  const reload = update.state === 'done' && !!update.finishedAt && update.finishedAt > loadedAt

  const send = async (request: () => Promise<AppUpdate>) => {
    setSending(true)
    try {
      queryClient.setQueryData(queryKeys.appUpdate, await request())
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label="Update ultrakanban">
          {busy ? <Loader2Icon className="animate-spin" /> : <CircleArrowUpIcon />}
          {!busy && (behind > 0 || reload || update.state === 'failed') && (
            <span
              className={cn(
                'absolute top-1 right-1 size-2 rounded-full',
                update.state === 'failed' ? 'bg-destructive' : 'bg-primary',
              )}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-80 gap-3">
        <div className="grid gap-1">
          <p className="text-sm font-medium">Update ultrakanban</p>
          {update.version && <p className="truncate font-mono text-xs text-muted-foreground">{update.version}</p>}
          {update.behind !== null && (
            <p className="text-xs text-muted-foreground">
              {behind > 0 ? `${behind} new commit${behind === 1 ? '' : 's'} to update to.` : 'Up to date.'}
            </p>
          )}
        </div>
        <UpdateStatus update={update} />
        {offline && (
          <p className="text-xs text-muted-foreground">
            The agent supervisor last checked in {formatRelative(update.updaterSeenAt)}; an update starts once it is
            back.
          </p>
        )}
        <div className="flex justify-end gap-2">
          {reload && (
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          )}
          {update.state === 'requested' ? (
            <Button size="sm" variant="outline" disabled={sending} onClick={() => send(api.cancelAppUpdate)}>
              Cancel update
            </Button>
          ) : (
            <Button size="sm" disabled={busy || sending} onClick={() => setConfirming(true)}>
              Update & restart
            </Button>
          )}
        </div>
      </PopoverContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Update and restart ultrakanban?"
        description="The agent supervisor pulls the latest version, rebuilds the board and restarts it. The board is unreachable for a minute or so meanwhile; agent runs carry on."
        confirmLabel="Update & restart"
        onConfirm={() => send(api.requestAppUpdate)}
      />
    </Popover>
  )
}
