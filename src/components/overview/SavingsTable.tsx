import { formatCost } from '@/lib/format'
import { saved, savedShare, type Savings, type SavingsSource, type SavingsTotals } from '@/lib/overview'

const SOURCES: { source: SavingsSource; label: string; detail: string }[] = [
  {
    source: 'ultrakanban',
    label: 'ultrakanban',
    detail: 'The board’s default, the similar-tickets suggestion and tickets’ own settings',
  },
  { source: 'jev', label: 'Jev', detail: 'Runs at the setting Jev picked, and Jev’s own requests' },
]

function Row({
  label,
  detail,
  totals,
  total,
}: {
  label: string
  detail?: string
  totals: SavingsTotals
  total?: boolean
}) {
  const cell = 'px-3 py-2 text-right tabular-nums'
  return (
    <tr className={total ? 'bg-muted/30 font-medium' : 'border-b hover:bg-muted/50'}>
      <th scope="row" className="px-3 py-2 text-left font-medium" title={detail}>
        {label}
      </th>
      <td className={cell}>{totals.runs}</td>
      <td className={cell} title={totals.jevUsd > 0 ? `${formatCost(totals.jevUsd)} of it on Jev` : undefined}>
        {formatCost(totals.actualUsd)}
      </td>
      <td className={cell}>{formatCost(totals.opusUsd)}</td>
      <td className={cell}>{formatCost(saved(totals))}</td>
      <td className={cell}>{savedShare(totals)}</td>
    </tr>
  )
}

/** What runs routed by ultrakanban and by Jev cost against the same tokens on Opus. */
export function SavingsTable({ savings }: { savings: Savings }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-[13px]">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Routed by
            </th>
            {['Runs', 'Spent', 'On Opus', 'Saved', 'Share'].map((label) => (
              <th key={label} scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SOURCES.map(({ source, label, detail }) => (
            <Row key={source} label={label} detail={detail} totals={savings.bySource[source]} />
          ))}
          <Row label="All" totals={savings.total} total />
        </tbody>
      </table>
    </div>
  )
}
