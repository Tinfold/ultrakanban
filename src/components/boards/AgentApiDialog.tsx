import { CheckIcon, CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { useState } from 'react'
import type { Column } from '@shared/domain'
import { useBoardContext } from '@/components/board/board-context'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

function CodeBlock({ title, code, wrap }: { title: string; code: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="min-w-0 shrink-0 overflow-hidden rounded-lg border">
      <div className="flex h-8 items-center justify-between border-b bg-muted/50 pr-1 pl-3 text-xs font-medium">
        {title}
        <Button variant="ghost" size="icon-xs" aria-label={`Copy ${title}`} onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      <pre
        className={cn(
          'overflow-x-auto p-3 font-mono text-xs leading-relaxed',
          wrap && 'break-words whitespace-pre-wrap',
        )}
      >
        {code}
      </pre>
    </div>
  )
}

/** Prefers a column whose name matches, falling back to a position. */
const pickColumn = (columns: Column[], pattern: RegExp, fallbackIndex: number) =>
  (columns.find((column) => pattern.test(column.name)) ?? columns[fallbackIndex])?.name

export function AgentApiDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { detail, columnsById } = useBoardContext()
  const api = `${window.location.origin}/api`
  const boardPath = `/boards/${detail.board.id}`
  const todo = pickColumn(detail.columns, /^to ?do$/i, 0) ?? 'Todo'
  const inProgress = pickColumn(detail.columns, /progress|doing/i, 1) ?? 'In progress'
  const review = detail.board.reviewColumnId && columnsById.get(detail.board.reviewColumnId)?.name
  const done =
    (detail.board.doneColumnId && columnsById.get(detail.board.doneColumnId)?.name) || detail.columns.at(-1)?.name
  const json = (value: object) => `'${JSON.stringify(value)}'`
  const post = (path: string, body: object) =>
    `curl -s -X POST ${api}${path} \\\n  -H 'Content-Type: application/json' -H 'X-Actor: agent-1' \\\n  -d ${json(body)}`

  const finish = review
    ? `5. Open a GitHub pull request, then submit for review: POST /tickets/<id>/review {"agent":"<your name>","pullRequest":"<PR URL>","comment":"<what changed and how you verified it>"}. This links the PR and moves the ticket to "${review}".
6. Answer feedback until the PR is merged: re-read GET /tickets/<id>/activity for new ticket comments and check the PR's review comments (gh pr view --comments, gh api repos/<owner>/<repo>/pulls/<n>/comments). Push fixes, reply, and comment on the ticket.
7. Never move tickets to "${done}" yourself. They move there automatically once the pull request is merged.

Work one ticket at a time, and use a fresh agent per ticket so context stays small.`
    : `5. Before finishing, re-read GET /tickets/<id>/activity for new comments and address them.
6. When finished, comment a summary and move the ticket to "${done}" with POST /tickets/<id>/move {"column":"${done}"}.

Work one ticket at a time, and use a fresh agent per ticket so context stays small.`

  const snippets = [
    {
      title: 'Agent instructions',
      wrap: true,
      code: `Track your work on the kanban board through its HTTP API at ${api} (reference: GET ${api}).
Board id: ${detail.board.id}. Send the header "X-Actor: <your name>" on every request.

1. Claim a ticket: POST ${boardPath}/tickets/claim-next {"agent":"<your name>","column":"${todo}","moveTo":"${inProgress}"}.
2. Read the ticket and its comments: GET /tickets/<id> and GET /tickets/<id>/activity. Comments may be newer than the description; follow the newest instruction and ask in a comment if they conflict.
3. Post progress and decisions with POST /tickets/<id>/comments {"body":"<markdown>"}.
4. If the change is visible (UI, styling, charts, CLI output), attach screenshots or a short screen recording to the ticket so reviewers can see the result without running it: POST /tickets/<id>/attachments as multipart/form-data with the file in a field named "file" (curl -F file=@screenshot.png). PNG, JPEG, GIF, WebP, MP4 or WebM, up to 25 MB each.
${finish}`,
    },
    { title: 'Read the board', code: `curl -s ${api}${boardPath}` },
    {
      title: 'Add a ticket',
      code: post(`${boardPath}/tickets`, {
        title: 'Investigate flaky test',
        column: todo,
        priority: 'high',
        tags: ['bug'],
      }),
    },
    {
      title: 'Claim the next ticket',
      code: post(`${boardPath}/tickets/claim-next`, { agent: 'agent-1', column: todo, moveTo: inProgress }),
    },
    {
      title: 'Attach a screenshot',
      code: `curl -s -X POST ${api}/tickets/$TICKET_ID/attachments \\\n  -H 'X-Actor: agent-1' -F file=@screenshot.png`,
    },
    review
      ? {
          title: 'Submit for review',
          code: post('/tickets/$TICKET_ID/review', {
            agent: 'agent-1',
            pullRequest: 'https://github.com/owner/repo/pull/123',
            comment: 'Adds rate limiting. Screenshots are attached to the ticket.',
          }),
        }
      : { title: 'Move a ticket', code: post('/tickets/$TICKET_ID/move', { column: done }) },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agent API</DialogTitle>
          <DialogDescription>
            Paste the instructions into your agent. Every write is atomic: claims can’t be double-assigned and stale
            edits are rejected with <code>ifVersion</code>. Columns and tags accept ids or names.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-1">
          {snippets.map((snippet) => (
            <CodeBlock key={snippet.title} {...snippet} />
          ))}
          <Button variant="outline" asChild className="self-start">
            <a href="/api" target="_blank" rel="noreferrer">
              Full API reference
              <ExternalLinkIcon />
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
