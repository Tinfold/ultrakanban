import type { SettingReport } from '@shared/domain'
import { formatCost, formatTokens } from '@/lib/format'

const percent = (rate: number) => `${Math.round(rate * 100)}%`

/** Cost per ticket and success rate of each model and effort, on the tickets it did most of the work on. */
export function SettingsTable({ settings }: { settings: SettingReport[] }) {
  if (!settings.length) {
    return <p className="text-sm text-muted-foreground">No ticket has been finished or given up on yet.</p>
  }
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-[13px]">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Model
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Effort
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
              Tickets
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
              Finished
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
              Success
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-right font-medium whitespace-nowrap"
              title="Average over the tickets whose runs reported a cost, else tokens"
            >
              Per ticket
            </th>
          </tr>
        </thead>
        <tbody>
          {settings.map((setting) => (
            <tr key={`${setting.model}/${setting.effort}`} className="border-b last:border-0 hover:bg-muted/50">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                {setting.model}
              </th>
              <td className="px-3 py-2 text-left">{setting.effort}</td>
              <td className="px-3 py-2 text-right tabular-nums">{setting.tickets}</td>
              <td className="px-3 py-2 text-right tabular-nums">{setting.finished}</td>
              <td className="px-3 py-2 text-right tabular-nums">{percent(setting.successRate)}</td>
              <td className="px-3 py-2 text-right tabular-nums" title={`${formatTokens(setting.tokens)} tokens`}>
                {setting.costUsd !== null ? formatCost(setting.costUsd) : `${formatTokens(setting.tokens)} tokens`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
