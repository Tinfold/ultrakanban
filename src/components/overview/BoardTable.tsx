import { BotIcon } from 'lucide-react'
import { Link } from 'wouter'
import type { OverviewBoard } from '@shared/domain'
import { formatDateTime, formatRelative } from '@/lib/format'

const COUNTS = [
  ['open', 'Open'],
  ['working', 'Working'],
  ['review', 'In review'],
  ['completed', 'Completed'],
  ['events', 'Events'],
] as const

export function BoardTable({ boards }: { boards: OverviewBoard[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-[13px]">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Board
            </th>
            {COUNTS.map(([key, label]) => (
              <th key={key} scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                {label}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
              Last activity
            </th>
          </tr>
        </thead>
        <tbody>
          {boards.map((board) => (
            <tr key={board.id} className="border-b last:border-0 hover:bg-muted/50">
              <th scope="row" className="px-3 py-2 text-left font-medium">
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
