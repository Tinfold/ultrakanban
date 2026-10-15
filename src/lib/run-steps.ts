import type { RunRecord, RunStep } from '@shared/domain'

/** A run's tool call with its number in the run (from 1), which counts the calls its record left out. */
export interface NumberedStep extends RunStep {
  number: number
}

/** What to show of a run's tool calls: those of one tool, those that reported an error, those whose text matches. */
export interface StepFilter {
  tool: string | null
  errorsOnly: boolean
  query: string
}

export const NO_STEP_FILTER: StepFilter = { tool: null, errorsOnly: false, query: '' }

export function isFiltering(filter: StepFilter) {
  return filter.tool !== null || filter.errorsOnly || filter.query.trim() !== ''
}

/** The run's tool calls, numbered as in the run: the calls after the left-out ones are numbered after them. */
export function numberSteps(run: Pick<RunRecord, 'steps' | 'omittedSteps'>): NumberedStep[] {
  const omitted = run.omittedSteps
  return run.steps.map((step, index) => ({
    ...step,
    number: index + 1 + (omitted && index >= omitted.after ? omitted.count : 0),
  }))
}

/** The calls the filter keeps; its query matches the tool's name or the call's target, ignoring case. */
export function filterSteps(steps: NumberedStep[], filter: StepFilter) {
  const query = filter.query.trim().toLowerCase()
  return steps.filter(
    (step) =>
      (filter.tool === null || step.tool === filter.tool) &&
      (!filter.errorsOnly || step.error) &&
      (!query || step.tool.toLowerCase().includes(query) || step.summary.toLowerCase().includes(query)),
  )
}

/** How many calls the run made of each tool, the most used first. */
export function countTools(steps: RunStep[]) {
  const counts = new Map<string, number>()
  for (const step of steps) counts.set(step.tool, (counts.get(step.tool) ?? 0) + 1)
  return [...counts].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count)
}
