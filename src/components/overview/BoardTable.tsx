import { BotIcon } from 'lucide-react'
import { Link } from 'wouter'
import type { BoardDiskUsage, OverviewBoard } from '@shared/domain'
import { COST_NOTE, formatBytes, formatCost, formatDateTime, formatRelative, formatTokens } from '@/lib/format'
import { diskBytes } from '@/lib/overview'

const COUNTS = [
  ['open', 'Open'],
  ['working', 'Working'],
  ['review', 'In review'],
  ['completed', 'Completed'],
  ['events', 'Events'],
] as const

/** What a board's disk space is made of, for its cell's tooltip. */
function diskDetail({ attachments, agent }: BoardDiskUsage) {
  const lines = agent
    ? [
        `Clone: ${formatBytes(agent.repo)}`,
        `Worktrees: ${formatBytes(agent.worktrees)}`,
        `Agent state and scratch files: ${formatBytes(agent.state)}`,
      ]
    : ['Agent folder: not measured']
  lines.push(`Attachments: ${formatBytes(attachments)}`)
  if (agent) lines.push(`Measured ${formatRelative(agent.measuredAt)}`)
  return lines.join('\n')
}

export function BoardTable({ boards }: { boards: OverviewBoard[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-[13px]">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th
              scope="col"
              className="sticky left-0 bg-card px-3 py-2 text-left font-medium sm:static sm:bg-transparent"
            >
              Board
            </th>
            {COUNTS.map(([key, label]) => (
              <th key={key} scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                {label}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
              Tokens
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap" title={COST_NOTE}>
              Cost (est.)
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
              Disk
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
              Last activity
            </th>
          </tr>
        </thead>
        <tbody>
          {boards.map((board) => (
            <tr key={board.id} className="border-b last:border-0 hover:bg-muted/50">
              <th
                scope="row"
                className="sticky left-0 bg-card px-3 py-2 text-left font-medium sm:static sm:bg-transparent"
              >
                <Link href={`/b/${board.id}`} className="inline-flex items-center gap-1.5 hover:underline">
                  {board.name}
                  {board.agentEnabled && (
                    <BotIcon
                      className="size-3.5 text-muted-foreground"
                      aria-label={`Agent on (${board.agentName ?? 'claude'})`}
                    />
                  )}
                </Link>
              </th>
              {COUNTS.map(([key]) => (
                <td key={key} className="px-3 py-2 text-right tabular-nums">
                  {board[key] || <span className="text-muted-foreground/60">0</span>}
                </td>
              ))}
              <td className="px-3 py-2 text-right tabular-nums" title={`${board.tokens.toLocaleString()} tokens`}>
                {board.tokens ? formatTokens(board.tokens) : <span className="text-muted-foreground/60">0</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums" title={COST_NOTE}>
                {board.costUsd === null ? (
                  <span className="text-muted-foreground/60">—</span>
                ) : (
                  formatCost(board.costUsd)
                )}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums" title={diskDetail(board.disk)}>
                {diskBytes(board.disk) ? (
                  formatBytes(diskBytes(board.disk))
                ) : (
                  <span className="text-muted-foreground/60">0</span>
                )}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground">
                {board.lastActivityAt ? (
                  <time dateTime={board.lastActivityAt} title={formatDateTime(board.lastActivityAt)}>
                    {formatRelative(board.lastActivityAt)}
                  </time>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
