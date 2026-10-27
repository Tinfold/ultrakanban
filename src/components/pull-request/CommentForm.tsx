import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import type { DiffSide } from '@shared/domain'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { queryKeys } from '@/hooks/queries'
import { api, errorMessage } from '@/lib/api'

interface CommentFormProps {
  boardId: string
  number: number
  /** Where an inline comment goes; left out for a comment on the whole pull request. */
  inline?: { path: string; line: number; side: DiffSide }
  onDone?: () => void
  autoFocus?: boolean
}

/** A markdown comment on a local pull request, on the whole of it or on one line of its diff. */
export function CommentForm({ boardId, number, inline, onDone, autoFocus }: CommentFormProps) {
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!body.trim() || sending) return
    setSending(true)
    try {
      await api.commentOnLocalPullRequest(boardId, number, { body, ...inline })
      setBody('')
      await queryClient.invalidateQueries({ queryKey: queryKeys.localPullRequest(boardId, number) })
      onDone?.()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-2">
      <Textarea
        value={body}
        autoFocus={autoFocus}
        aria-label={inline ? `Comment on line ${inline.line}` : 'Comment'}
        placeholder={inline ? 'Comment on this line (markdown)' : 'Leave a comment (markdown)'}
        className="min-h-20 bg-background font-sans"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit()
          if (event.key === 'Escape' && onDone) onDone()
        }}
      />
      <div className="flex justify-end gap-2">
        {onDone && (
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!body.trim() || sending}>
          Comment
        </Button>
      </div>
    </form>
  )
}
