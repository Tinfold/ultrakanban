import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { useBoardContext } from '@/components/board/board-context'
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
import { queryKeys } from '@/hooks/queries'
import { api, errorMessage } from '@/lib/api'

/** A repository name suggested from the board's name, e.g. "Product roadmap" → "product-roadmap". */
const repoName = (boardName: string) =>
  boardName
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)

/** Creates a repository on GitHub with the server's login and links it to the board. */
export function CreateGitHubRepoDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (repo: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New GitHub repository</DialogTitle>
          <DialogDescription>
            Created with the server's GitHub login, with a README so it has a main branch, and linked to this board.
          </DialogDescription>
        </DialogHeader>
        <CreateGitHubRepoForm
          onClose={() => onOpenChange(false)}
          onCreated={(repo) => {
            onCreated(repo)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function CreateGitHubRepoForm({ onClose, onCreated }: { onClose: () => void; onCreated: (repo: string) => void }) {
  const { detail } = useBoardContext()
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // The dialog is portalled out of the settings form, but React still bubbles its submit event there.
    event.stopPropagation()
    const data = new FormData(event.currentTarget)
    const text = (field: string) => String(data.get(field) ?? '').trim() || undefined
    const name = text('name')
    if (!name) return
    setSaving(true)
    try {
      const board = await api.createGitHubRepo(detail.board.id, {
        owner: text('owner'),
        name,
        description: text('description'),
        private: data.get('private') === 'on',
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.board(detail.board.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.boards }),
      ])
      toast.success(`Created ${board.githubRepo} and linked it to this board`)
      onCreated(board.githubRepo ?? '')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="new-repo-owner">Owner</Label>
          <Input
            id="new-repo-owner"
            name="owner"
            placeholder="Your account"
            pattern="[A-Za-z\d][A-Za-z\d\-]{0,38}"
            title="A GitHub user or organization"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="new-repo-name">Name</Label>
          <Input
            id="new-repo-name"
            name="name"
            required
            autoFocus
            defaultValue={repoName(detail.board.name)}
            pattern="[\w.\-]{1,100}"
            title="Letters, digits, '.', '_' and '-'"
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="new-repo-description">Description</Label>
        <Input id="new-repo-description" name="description" maxLength={350} placeholder="Optional" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="private" defaultChecked className="size-4 accent-primary" />
        Private
      </label>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Creating…' : 'Create and link'}
        </Button>
      </DialogFooter>
    </form>
  )
}
