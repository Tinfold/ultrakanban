import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react'
import type { FormEvent } from 'react'
import { useBoardContext } from '@/components/board/board-context'
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

const NONE = '__none'

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
  const { detail, actions } = useBoardContext()

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const name = String(data.get('name') ?? '').trim()
    if (!name) return
    const columnId = (field: string) => {
      const value = String(data.get(field) ?? NONE)
      return value === NONE ? null : value
    }
    void actions.updateBoard({
      name,
      description: String(data.get('description') ?? ''),
      reviewColumnId: columnId('reviewColumn'),
      doneColumnId: columnId('doneColumn'),
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Board settings</DialogTitle>
          <DialogDescription>Agents see the description when they read the board.</DialogDescription>
        </DialogHeader>
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

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
