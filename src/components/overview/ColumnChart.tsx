import { type CSSProperties, type ReactNode, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface ChartSeries {
  label: string
  /** CSS color, e.g. `var(--chart-1)`. */
  color: string
}

export interface ChartColumn {
  /** Axis label; only some are shown when columns are dense. */
  label: string
  /** Tooltip and table heading. */
  title: string
  /** One value per series, stacked from the baseline in series order. */
  values: number[]
}

interface ColumnChartProps {
  title: string
  description: ReactNode
  series: ChartSeries[]
  columns: ChartColumn[]
  formatValue: (value: number) => string
  formatTick?: (value: number) => string
  /** Smallest gridline step, e.g. 1 for counts. */
  minStep?: number
  className?: string
}

const AXIS_LABELS = 7

/** Rounds the axis up to 1, 2 or 5 × 10ⁿ steps, about four gridlines. */
function niceTicks(max: number, minStep: number) {
  const raw = Math.max(max / 4, minStep)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw)!
  const top = Math.max(step, Math.ceil(max / step) * step)
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/** Stacked column chart with a hover/focus tooltip per column and a table for screen readers. */
export function ColumnChart({
  title,
  description,
  series,
  columns,
  formatValue,
  formatTick = formatValue,
  minStep = 0,
  className,
}: ColumnChartProps) {
  const totals = columns.map((column) => sum(column.values))
  const ticks = niceTicks(Math.max(0, ...totals), minStep)
  const top = ticks.at(-1)!
  const labelEvery = Math.ceil(columns.length / AXIS_LABELS)
  const empty = totals.every((total) => total === 0)
  const [open, setOpen] = useState<number | null>(null)

  return (
    <figure className={cn('relative grid gap-4 rounded-xl border bg-card p-4', className)}>
      <figcaption className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {series.length > 1 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {series.map((item) => (
              <li key={item.label} className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-[3px] bg-(--swatch)"
                  style={{ '--swatch': item.color } as CSSProperties}
                />
                {item.label}
              </li>
            ))}
          </ul>
        )}
      </figcaption>

      <div aria-hidden className="grid grid-cols-[auto_1fr] gap-x-2">
        <div className="relative h-40">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
              style={{ bottom: `${(tick / top) * 100}%` }}
            >
              {formatTick(tick)}
            </span>
          ))}
          {/* Keeps the axis wide enough for its longest label. */}
          <span className="invisible text-[10px] tabular-nums">{formatTick(top)}</span>
        </div>
        <div className="relative h-40">
          {ticks.map((tick) => (
            <div key={tick} className="absolute inset-x-0 border-t" style={{ bottom: `${(tick / top) * 100}%` }} />
          ))}
          {empty && (
            <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
              Nothing in this range
            </p>
          )}
          <div className="absolute inset-0 flex">
            {columns.map((column, i) => (
              <Tooltip
                key={column.title}
                open={open === i}
                onOpenChange={(next) => setOpen((current) => (next ? i : current === i ? null : current))}
              >
                <TooltipTrigger asChild>
                  <div
                    tabIndex={empty ? -1 : 0}
                    onClick={(event) => {
                      // Tooltips only open on hover and focus, never on touch: a tap shows the column's values
                      // instead of closing them. Preventing default stops the trigger's own close on click.
                      event.preventDefault()
                      setOpen(i)
                    }}
                    className="group flex h-full min-w-0 flex-1 items-end justify-center rounded-sm outline-none focus-visible:bg-muted/60"
                  >
                    <div
                      className="flex w-full max-w-6 flex-col-reverse gap-0.5 px-px transition-opacity group-hover:opacity-80 group-focus-visible:opacity-80 sm:px-0.5"
                      style={{ height: `${(totals[i] / top) * 100}%` }}
                    >
                      {column.values.map(
                        (value, s) =>
                          value > 0 && (
                            <div
                              key={series[s].label}
                              className="min-h-0.5 bg-(--swatch) last:rounded-t-[4px]"
                              style={{ '--swatch': series[s].color, flex: `${value} 1 0` } as CSSProperties}
                            />
                          ),
                      )}
                    </div>
                  </div>
                </TooltipTrigger>
                {!empty && (
                  <TooltipContent side="top" className="grid gap-1 px-2.5 py-2">
                    <p className="font-medium">{column.title}</p>
                    {series.map((item, s) => (
                      <p key={item.label} className="flex items-center gap-2">
                        <span
                          className="h-0.5 w-2.5 rounded-full bg-(--swatch)"
                          style={{ '--swatch': item.color } as CSSProperties}
                        />
                        <span className="font-semibold tabular-nums">{formatValue(column.values[s])}</span>
                        {series.length > 1 && <span className="opacity-70">{item.label}</span>}
                      </p>
                    ))}
                  </TooltipContent>
                )}
              </Tooltip>
            ))}
          </div>
        </div>
        <div />
        <div className="mt-1.5 flex text-[10px] text-muted-foreground">
          {columns.map((column, i) => (
            <span key={column.title} className="flex min-w-0 flex-1 justify-center overflow-visible whitespace-nowrap">
              {(columns.length - 1 - i) % labelEvery === 0 ? column.label : ''}
            </span>
          ))}
        </div>
      </div>

      {/* Tables ignore the width sr-only sets, so a wrapper hides it. */}
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {series.map((item) => (
                <th key={item.label} scope="col">
                  {item.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.title}>
                <th scope="row">{column.title}</th>
                {column.values.map((value, s) => (
                  <td key={series[s].label}>{formatValue(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  )
}
