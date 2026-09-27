import { CircleAlertIcon, CircleCheckIcon, PlusIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useBoardContext } from '@/components/board/board-context'
import { CreateGitHubRepoDialog } from '@/components/boards/CreateGitHubRepoDialog'
import { ColorDot } from '@/components/common/TagChip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useGitHubStatus } from '@/hooks/queries'
import { AGENT_DEFAULTS, AGENT_EFFORTS, AGENT_MAX_CONCURRENCY, type AgentEffort, agentWorkerName } from '@shared/domain'

const NONE = '__none'
const DEFAULT_EFFORT = '__default'
const DEFAULT_CONCURRENCY = '__default'

function ColumnSelect({ id, name, value }: { id: string; name: string; value: string | null }) {
  const { detail } = useBoardContext()
  return (
    <Select name={name} defaultValue={value ?? NONE}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>None</SelectItem>
        {detail.columns.map((column) => (
          <SelectItem key={column.id} value={column.id}>
            <ColorDot color={column.color} />
            {column.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function GitHubStatus() {
  const { data } = useGitHubStatus()
  if (!data) return null
  if (data.auth) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleCheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        Checking pull requests on GitHub using {data.auth === 'gh' ? 'your gh CLI login' : 'GITHUB_TOKEN'}.
      </p>
    )
  }
  return (
    <p className="flex gap-1.5 text-xs text-muted-foreground">
      <CircleAlertIcon className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <span>
        Not signed in to GitHub, so only public repositories can be checked. Set <code>GITHUB_TOKEN</code> or run{' '}
        <code>gh auth login</code>, then restart the server.
      </span>
    </p>
  )
}

export function BoardSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Board settings</DialogTitle>
          <DialogDescription>Agents see the description when they read the board.</DialogDescription>
        </DialogHeader>
        <BoardSettingsForm onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

/** Mounted with the dialog's content, so it starts from the saved settings each time the dialog opens. */
function BoardSettingsForm({ onClose }: { onClose: () => void }) {
  const { detail, actions } = useBoardContext()
  const [agent, setAgent] = useState(() => {
    const { agentName, agentModel, agentEffort } = detail.board
    return { agentName, agentModel, agentEffort }
  })
  const [agentConcurrency, setAgentConcurrency] = useState(detail.board.agentConcurrency)
  const [githubRepo, setGithubRepo] = useState(detail.board.githubRepo ?? '')
  const [creatingRepo, setCreatingRepo] = useState(false)
  const signedIn = !!useGitHubStatus().data?.auth

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const name = String(data.get('name') ?? '').trim()
    if (!name) return
    const columnId = (field: string) => {
      const value = String(data.get(field) ?? NONE)
      return value === NONE ? null : value
    }
    const text = (field: string) => String(data.get(field) ?? '').trim() || null
    void actions.updateBoard({
      name,
      description: String(data.get('description') ?? ''),
      reviewColumnId: columnId('reviewColumn'),
      doneColumnId: columnId('doneColumn'),
      githubRepo: text('githubRepo'),
      agentName: text('agentName'),
      agentModel: text('agentModel'),
      agentEffort: agent.agentEffort,
      agentConcurrency,
      agentEnabled: data.get('agentEnabled') === 'on',
    })
    onClose()
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="board-settings-name">Name</Label>
        <Input id="board-settings-name" name="name" required defaultValue={detail.board.name} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="board-settings-description">Description</Label>
        <Textarea
          id="board-settings-description"
          name="description"
          rows={3}
          defaultValue={detail.board.description}
          placeholder="What is this board for? Conventions for agents?"
        />
      </div>

      <fieldset className="grid gap-3 border-t pt-4">
        <legend className="sr-only">Pull request workflow</legend>
        <div className="grid gap-1">
          <h3 className="text-sm font-medium">Pull request workflow</h3>
          <p className="text-xs text-muted-foreground">
            Agents submit tickets to the review column with their GitHub pull request. Tickets only enter the done
            column once that pull request is merged, and move there automatically when it is.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label htmlFor="board-settings-review">Review column</Label>
            <ColumnSelect id="board-settings-review" name="reviewColumn" value={detail.board.reviewColumnId} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="board-settings-done">Done column</Label>
            <ColumnSelect id="board-settings-done" name="doneColumn" value={detail.board.doneColumnId} />
          </div>
        </div>
        <GitHubStatus />
      </fieldset>

      <fieldset className="grid gap-3 border-t pt-4">
        <legend className="sr-only">Agent</legend>
        <div className="grid gap-1">
          <h3 className="text-sm font-medium">Agent</h3>
          <p className="text-xs text-muted-foreground">
            When on, the agent service on the host works this board: it claims tickets, opens pull requests in its own
            clone of the repository and answers review feedback. It runs Claude Code without permission prompts.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="board-settings-repo">GitHub repository</Label>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto p-0"
                disabled={!signedIn}
                title={signedIn ? 'Create a repository on GitHub for this board' : 'Sign in to GitHub first'}
                onClick={() => setCreatingRepo(true)}
              >
                <PlusIcon />
                New
              </Button>
            </div>
            <Input
              id="board-settings-repo"
              name="githubRepo"
              value={githubRepo}
              onChange={(event) => setGithubRepo(event.target.value)}
              placeholder="owner/name"
              pattern="[\w.\-]+/[\w.\-]+"
              title="owner/name"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="board-settings-agent-name">Agent name</Label>
            <Input
              id="board-settings-agent-name"
              name="agentName"
              defaultValue={detail.board.agentName ?? ''}
              placeholder={AGENT_DEFAULTS.name}
              pattern="[\w.\-]{1,64}"
              onChange={(event) => setAgent({ ...agent, agentName: event.target.value.trim() || null })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="board-settings-agent-model">Model</Label>
            <Input
              id="board-settings-agent-model"
              name="agentModel"
              defaultValue={detail.board.agentModel ?? ''}
              placeholder={AGENT_DEFAULTS.model}
              pattern="[\w.\[\]\-]{1,100}"
              title="A model alias or name, e.g. opus or claude-opus-5-5"
              onChange={(event) => setAgent({ ...agent, agentModel: event.target.value.trim() || null })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="board-settings-agent-effort">Effort</Label>
            <Select
              value={agent.agentEffort ?? DEFAULT_EFFORT}
              onValueChange={(value) =>
                setAgent({ ...agent, agentEffort: value === DEFAULT_EFFORT ? null : (value as AgentEffort) })
              }
            >
              <SelectTrigger id="board-settings-agent-effort" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_EFFORT}>Default ({AGENT_DEFAULTS.effort})</SelectItem>
                {AGENT_EFFORTS.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {effort}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="board-settings-agent-concurrency">Parallel runs</Label>
            <Select
              value={String(agentConcurrency ?? DEFAULT_CONCURRENCY)}
              onValueChange={(value) => setAgentConcurrency(value === DEFAULT_CONCURRENCY ? null : Number(value))}
            >
              <SelectTrigger id="board-settings-agent-concurrency" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_CONCURRENCY}>Default ({AGENT_DEFAULTS.concurrency})</SelectItem>
                {Array.from({ length: AGENT_MAX_CONCURRENCY }, (_, index) => String(index + 1)).map((count) => (
                  <SelectItem key={count} value={count}>
                    {count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          It claims tickets as <code>{agentWorkerName(agent)}</code>. A full model name, such as claude-opus-5-5, keeps
          each model version apart on the board. With more than one parallel run, it works that many tickets at once,
          each in its own git worktree, all on your Claude usage.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="agentEnabled"
            defaultChecked={detail.board.agentEnabled}
            className="size-4 accent-primary"
          />
          Run the agent on this board
        </label>
      </fieldset>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
      <CreateGitHubRepoDialog open={creatingRepo} onOpenChange={setCreatingRepo} onCreated={setGithubRepo} />
    </form>
  )
}
