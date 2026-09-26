import { useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { type ReactNode, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { OVERVIEW_RANGES, type OverviewRange } from '@shared/domain'
import { AppHeader } from '@/components/app/AppHeader'
import { AgentList } from '@/components/overview/AgentList'
import { BoardTable } from '@/components/overview/BoardTable'
import { type ChartSeries, ColumnChart } from '@/components/overview/ColumnChart'
import { RecentActivity } from '@/components/overview/RecentActivity'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { queryKeys, useOverview } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { useStoredState } from '@/hooks/use-stored-state'
import { api, errorMessage } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { dailyActivity, workedByAgent } from '@/lib/overview'
import { storageKeys } from '@/lib/storage'
import { cn } from '@/lib/utils'

const ACTIVITY_SERIES = [
  { kind: 'completed', label: 'Completed', color: 'var(--chart-1)' },
  { kind: 'created', label: 'Created', color: 'var(--chart-2)' },
  { kind: 'comment', label: 'Comments', color: 'var(--chart-3)' },
  { kind: 'update', label: 'Other updates', color: 'var(--chart-4)' },
] as const

const WORK_SERIES: ChartSeries[] = [{ label: 'Worked', color: 'var(--chart-1)' }]

const HOUR_MS = 60 * 60 * 1000

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

interface SectionProps {
  title: string
  /** Controls shown next to the title. */
  actions?: ReactNode
  children: ReactNode
  className?: string
}

function Section({ title, actions, children, className }: SectionProps) {
  return (
    <section className={cn('grid grid-cols-1 content-start gap-3', className)}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function OverviewPage() {
  const [days, setDays] = useStoredState<OverviewRange>(storageKeys.overviewRange, 14)
  const { data: overview, error, isPlaceholderData } = useOverview(days)
  const now = useNow()
  const queryClient = useQueryClient()

  useEffect(() => {
    document.title = 'Overview · ultrakanban'
  }, [])

  const daily = useMemo(() => (overview ? dailyActivity(overview, now) : []), [overview, now])
  const worked = useMemo(
    () =>
      overview && daily.length ? workedByAgent(overview.sessions, daily[0].start, now) : new Map<string, number>(),
    [overview, daily, now],
  )

  const changeHidden = async (change: Promise<void>) => {
    try {
      await change
    } catch (error) {
      toast.error(errorMessage(error))
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.allOverviews })
  }

  const range = (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={String(days)}
      onValueChange={(value) => value && setDays(Number(value) as OverviewRange)}
      aria-label="Range"
    >
      {OVERVIEW_RANGES.map((option) => (
        <ToggleGroupItem key={option} value={String(option)} className="px-3">
          {option} days
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )

  let content: ReactNode = null
  if (error) {
    content = <p className="text-sm text-muted-foreground">Couldn’t load the overview: {error.message}</p>
  } else if (overview) {
    const { totals, agents, hiddenAgents } = overview
    // Idle agents that aren't a board's host agent are usually old or misspelled names.
    const stale = agents.filter((agent) => agent.status === 'idle' && !agent.agentOf.length).map((agent) => agent.name)
    const waiting = agents.filter((agent) => agent.status === 'review').length
    const completed = daily.reduce((total, day) => total + day.events.completed, 0)
    const workedMs = daily.reduce((total, day) => total + day.workedMs, 0)
    const columns = daily.map((day) => ({
      label: format(day.start, days === 7 ? 'EEE' : 'MMM d'),
      title: format(day.start, 'EEEE, MMM d'),
    }))

    content = (
      <div className={cn('grid grid-cols-1 gap-6 transition-opacity', isPlaceholderData && 'opacity-60')}>
        <div className="grid grid-cols-2 gap-3 *:last:col-span-2 md:grid-cols-3 md:*:last:col-span-1 xl:grid-cols-5">
          <Stat
            label="Agents working"
            value={totals.activeAgents}
            detail={`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}${waiting ? `, ${waiting} waiting for review` : ''}`}
          />
          <Stat label="Tickets being worked" value={totals.working} detail={`${totals.open} open tickets`} />
          <Stat label="In review" value={totals.review} detail="Waiting on a pull request" />
          <Stat label="Completed" value={completed} detail={`Last ${days} days`} />
          <Stat label="Time worked" value={formatDuration(workedMs)} detail={`Last ${days} days, all agents`} />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ColumnChart
            title="Activity"
            description={`Board events per day, across ${totals.boards} ${totals.boards === 1 ? 'board' : 'boards'}`}
            series={[...ACTIVITY_SERIES]}
            columns={daily.map((day, i) => ({
              ...columns[i],
              values: ACTIVITY_SERIES.map((series) => day.events[series.kind]),
            }))}
            formatValue={(value) => value.toLocaleString()}
            minStep={1}
          />
          <ColumnChart
            title="Time worked"
            description="Hours agents spent on claimed tickets per day, until review"
            series={WORK_SERIES}
            columns={daily.map((day, i) => ({ ...columns[i], values: [day.workedMs / HOUR_MS] }))}
            formatValue={(hours) => formatDuration(hours * HOUR_MS)}
            formatTick={(hours) => `${+hours.toFixed(1)}h`}
          />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="grid grid-cols-1 content-start gap-6">
            <Section
              title="Agents"
              actions={
                <>
                  {hiddenAgents.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      title={`Cleared: ${hiddenAgents.join(', ')}`}
                      className="text-muted-foreground"
                      onClick={() => changeHidden(api.showHiddenAgents())}
                    >
                      Show {hiddenAgents.length} cleared
                    </Button>
                  )}
                  {stale.length > 0 && (
                    <Button
                      variant="outline"
                      size="xs"
                      title="Clear idle agents that don’t run a board until they do something again"
                      onClick={() => changeHidden(api.hideAgents(stale))}
                    >
                      Clear idle
                    </Button>
                  )}
                </>
              }
            >
              <AgentList
                agents={agents}
                boards={overview.boards}
                worked={worked}
                now={now}
                hidden={hiddenAgents.length}
                onHide={(names) => changeHidden(api.hideAgents(names))}
              />
            </Section>
            <Section title="Boards">
              <BoardTable boards={overview.boards} />
            </Section>
          </div>
          <Section title="Recent activity">
            <RecentActivity activity={overview.recent} />
          </Section>
        </div>
      </div>
    )
  }

  return (
    <>
      <AppHeader />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-5 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
              <p className="text-sm text-muted-foreground">What’s happening across all boards.</p>
            </div>
            {range}
          </div>
          {content}
        </div>
      </main>
    </>
  )
}
