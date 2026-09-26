import { format } from 'date-fns'
import { type ReactNode, useEffect, useMemo } from 'react'
import { OVERVIEW_RANGES, type OverviewRange } from '@shared/domain'
import { AppHeader } from '@/components/app/AppHeader'
import { AgentList } from '@/components/overview/AgentList'
import { BoardTable } from '@/components/overview/BoardTable'
import { type ChartSeries, ColumnChart } from '@/components/overview/ColumnChart'
import { NeedsAttention } from '@/components/overview/NeedsAttention'
import { RecentActivity } from '@/components/overview/RecentActivity'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useOverview } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { useStoredState } from '@/hooks/use-stored-state'
import { formatDuration } from '@/lib/format'
import { dailyActivity, median, needsAttention, workedByAgent } from '@/lib/overview'
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

/** Anchors of the parts of the page stats and the jump bar link to. */
const SECTIONS = {
  attention: 'needs-attention',
  agents: 'agents',
  boards: 'boards',
  activity: 'activity',
  timeWorked: 'time-worked',
  recent: 'recent-activity',
} as const

type SectionId = (typeof SECTIONS)[keyof typeof SECTIONS]

interface StatProps {
  label: string
  value: ReactNode
  detail: ReactNode
  /** The section that breaks the number down. */
  target?: SectionId
}

function Stat({ label, value, detail, target }: StatProps) {
  const body = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
    </>
  )
  if (!target) return <div className="rounded-xl border bg-card p-4">{body}</div>
  return (
    <a
      href={`#${target}`}
      className="rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {body}
    </a>
  )
}

const tickets = (count: number) => `${count} ${count === 1 ? 'ticket' : 'tickets'}`

function JumpBar({ attention }: { attention: number }) {
  const links: [SectionId, string, number?][] = [
    [SECTIONS.attention, 'Needs attention', attention],
    [SECTIONS.agents, 'Agents'],
    [SECTIONS.boards, 'Boards'],
    [SECTIONS.recent, 'Recent activity'],
  ]
  return (
    <nav aria-label="Jump to" className="flex flex-wrap gap-2">
      {links.map(([id, label, count]) => (
        <a
          key={id}
          href={`#${id}`}
          className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {label}
          {!!count && (
            <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
              {count}
            </span>
          )}
        </a>
      ))}
    </nav>
  )
}

function formatMedian(values: number[]) {
  const value = median(values)
  return value === null ? '—' : formatDuration(value)
}

function Section({
  id,
  title,
  children,
  className,
}: {
  id: SectionId
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} className={cn('grid scroll-mt-4 grid-cols-1 content-start gap-3', className)}>
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  )
}

export function OverviewPage() {
  const [days, setDays] = useStoredState<OverviewRange>(storageKeys.overviewRange, 14)
  const { data: overview, error, isPlaceholderData } = useOverview(days)
  const now = useNow()

  useEffect(() => {
    document.title = 'Overview · ultrakanban'
  }, [])

  const daily = useMemo(() => (overview ? dailyActivity(overview, now) : []), [overview, now])
  const worked = useMemo(
    () =>
      overview && daily.length ? workedByAgent(overview.sessions, daily[0].start, now) : new Map<string, number>(),
    [overview, daily, now],
  )

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
    const { totals, agents } = overview
    const waiting = agents.filter((agent) => agent.status === 'review').length
    const completed = daily.reduce((total, day) => total + day.events.completed, 0)
    const workedMs = daily.reduce((total, day) => total + day.workedMs, 0)
    const created = daily.reduce((total, day) => total + day.events.created, 0)
    const attention = needsAttention(agents, now)
    const unclaimed = totals.open - totals.working - totals.review
    const completions = overview.completions.filter(
      (completion) => Date.parse(completion.at) >= daily[0].start.getTime(),
    )
    const cycleTimes = completions.flatMap((completion) => completion.cycleMs ?? [])
    const reviewTimes = completions.flatMap((completion) => completion.reviewMs ?? [])
    const columns = daily.map((day) => ({
      label: format(day.start, days === 7 ? 'EEE' : 'MMM d'),
      title: format(day.start, 'EEEE, MMM d'),
    }))

    content = (
      <div className={cn('grid grid-cols-1 gap-6 transition-opacity', isPlaceholderData && 'opacity-60')}>
        <JumpBar attention={attention.review.length + attention.stalled.length} />

        <div className="grid grid-cols-2 gap-3 *:last:col-span-2 md:grid-cols-3 md:*:last:col-span-1 xl:grid-cols-5">
          <Stat
            label="Agents working"
            value={totals.activeAgents}
            detail={`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}${waiting ? `, ${waiting} waiting for review` : ''}`}
            target={SECTIONS.agents}
          />
          <Stat
            label="Tickets being worked"
            value={totals.working}
            detail={`${totals.open} open tickets`}
            target={SECTIONS.agents}
          />
          <Stat
            label="In review"
            value={totals.review}
            detail="Waiting on a pull request"
            target={SECTIONS.attention}
          />
          <Stat label="Completed" value={completed} detail={`Last ${days} days`} target={SECTIONS.activity} />
          <Stat
            label="Time worked"
            value={formatDuration(workedMs)}
            detail={`Last ${days} days, all agents`}
            target={SECTIONS.timeWorked}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Stat
            label="Median cycle time"
            value={formatMedian(cycleTimes)}
            detail={`Start to done, ${tickets(cycleTimes.length)}`}
          />
          <Stat
            label="Median review wait"
            value={formatMedian(reviewTimes)}
            detail={`Until done, ${tickets(reviewTimes.length)}`}
          />
          <Stat
            label="Backlog"
            value={created === completed ? '±0' : `${created > completed ? '+' : '−'}${Math.abs(created - completed)}`}
            detail={`${created} created, ${completed} completed`}
            target={SECTIONS.activity}
          />
          <Stat label="Unclaimed" value={unclaimed} detail="Open and unassigned" target={SECTIONS.boards} />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ColumnChart
            id={SECTIONS.activity}
            className="scroll-mt-4"
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
            id={SECTIONS.timeWorked}
            className="scroll-mt-4"
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
            <Section id={SECTIONS.agents} title="Agents">
              <AgentList agents={agents} boards={overview.boards} worked={worked} now={now} />
            </Section>
            <Section id={SECTIONS.boards} title="Boards">
              <BoardTable boards={overview.boards} />
            </Section>
          </div>
          {/* On wide screens Recent activity takes what's left of the height of the Agents and Boards column
              beside it, and its list scrolls within that. */}
          <div className="grid grid-cols-1 content-start gap-6 xl:grid-rows-[auto_minmax(0,1fr)] xl:content-stretch">
            <Section id={SECTIONS.attention} title="Needs attention">
              <NeedsAttention review={attention.review} stalled={attention.stalled} now={now} />
            </Section>
            <Section
              id={SECTIONS.recent}
              title="Recent activity"
              className="xl:grid-rows-[auto_minmax(0,1fr)] xl:content-stretch"
            >
              <RecentActivity activity={overview.recent} />
            </Section>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <AppHeader />
      <main className="flex-1 overflow-y-auto motion-safe:scroll-smooth">
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
