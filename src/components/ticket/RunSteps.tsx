import { ChevronsDownUpIcon, ChevronsUpDownIcon, XIcon } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import type { RunRecord } from '@shared/domain'
import { Button } from '@/components/ui/button'
import {
  countTools,
  filterSteps,
  isFiltering,
  NO_STEP_FILTER,
  type NumberedStep,
  numberSteps,
  type StepFilter,
} from '@/lib/run-steps'
import { cn } from '@/lib/utils'

/** Runs with more tool calls than this get a button that shows them all, rather than in a list that scrolls. */
const SCROLL_AFTER = 15

function StepLine({ step }: { step: NumberedStep }) {
  return (
    <li
      className={cn(
        'flex min-w-0 gap-2 rounded px-1 py-px hover:bg-muted',
        step.error && 'text-red-600 dark:text-red-400',
      )}
    >
      <span className="w-7 shrink-0 text-right text-muted-foreground tabular-nums">{step.number}</span>
      <span className="w-20 shrink-0 truncate font-medium" title={step.tool}>
        {step.tool}
      </span>
      <span className="min-w-0 flex-1 font-mono text-[11px] wrap-anywhere">{step.summary}</span>
      {step.error && <XIcon aria-label="Reported an error" className="mt-px size-3.5 shrink-0" />}
    </li>
  )
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        pressed && 'border-foreground/30 bg-muted font-medium text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * A run's tool calls, numbered as in the run, with each call's whole target. They can be narrowed to one tool, to the
 * calls that reported an error, or to those matching a text, and a long run's list scrolls on its own (without
 * scrolling the ticket once it reaches an end) or can be shown in full.
 */
export function RunSteps({ run }: { run: RunRecord }) {
  const [filter, setFilter] = useState<StepFilter>(NO_STEP_FILTER)
  const [showAll, setShowAll] = useState(false)
  const steps = useMemo(() => numberSteps(run), [run])
  const tools = useMemo(() => countTools(run.steps), [run.steps])
  const errors = steps.filter((step) => step.error).length
  const total = steps.length + (run.omittedSteps?.count ?? 0)
  const filtering = isFiltering(filter)
  const shown = filterSteps(steps, filter)
  const update = (change: Partial<StepFilter>) => setFilter({ ...filter, ...change })

  const lines = shown.map((step) => <StepLine key={step.number} step={step} />)
  if (run.omittedSteps && !filtering) {
    lines.splice(
      run.omittedSteps.after,
      0,
      <li key="omitted" className="px-1 text-muted-foreground italic">
        … {run.omittedSteps.count} more {run.omittedSteps.count === 1 ? 'step' : 'steps'} …
      </li>,
    )
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <p className="mr-auto font-medium text-muted-foreground">
          {total} {total === 1 ? 'tool call' : 'tool calls'}
          {filtering && <>, {shown.length} shown</>}
        </p>
        {steps.length > 1 && (
          <input
            type="search"
            value={filter.query}
            onChange={(event) => update({ query: event.target.value })}
            placeholder="Filter"
            aria-label="Filter tool calls"
            className="h-6 w-36 min-w-0 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        )}
        {steps.length > SCROLL_AFTER && (
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            aria-label={showAll ? 'Show fewer tool calls' : 'Show all tool calls'}
            title={showAll ? 'Show fewer' : 'Show all'}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
          </Button>
        )}
      </div>
      {(tools.length > 1 || errors > 0) && (
        <div className="flex flex-wrap gap-1 text-muted-foreground">
          {errors > 0 && (
            <Chip pressed={filter.errorsOnly} onClick={() => update({ errorsOnly: !filter.errorsOnly })}>
              <XIcon className="size-3 text-red-600 dark:text-red-400" />
              {errors} {errors === 1 ? 'error' : 'errors'}
            </Chip>
          )}
          {tools.length > 1 &&
            tools.map(({ tool, count }) => (
              <Chip
                key={tool}
                pressed={filter.tool === tool}
                onClick={() => update({ tool: filter.tool === tool ? null : tool })}
              >
                <span className="max-w-40 truncate">{tool}</span>
                <span className="tabular-nums">{count}</span>
              </Chip>
            ))}
        </div>
      )}
      {lines.length > 0 ? (
        <ol
          className={cn(
            'grid content-start gap-px overflow-y-auto overscroll-contain rounded-md border bg-muted/30 p-1',
            !showAll && 'max-h-96',
          )}
        >
          {lines}
        </ol>
      ) : (
        <p className="text-muted-foreground">No tool calls match.</p>
      )}
    </div>
  )
}
