import { useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ActivityIcon, BotIcon, CoinsIcon, LayoutDashboardIcon, RouteIcon, SquareKanbanIcon } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'
import {
  mergeUsage,
  noUsage,
  type Overview,
  OVERVIEW_RANGES,
  type OverviewRange,
  totalTokens,
  type UsageTotals,
} from '@shared/domain'
import { AppHeader } from '@/components/app/AppHeader'
import { SideTabs } from '@/components/common/SideTabs'
import { AgentList } from '@/components/overview/AgentList'
import { BoardTable } from '@/components/overview/BoardTable'
import { ClaudeUsage, ClaudeUsageSummary } from '@/components/overview/ClaudeUsage'
import { type ChartSeries, ColumnChart } from '@/components/overview/ColumnChart'
import { NeedsAttention } from '@/components/overview/NeedsAttention'
import { RecentActivity } from '@/components/overview/RecentActivity'
import { RoutingTable } from '@/components/overview/RoutingTable'
import { SettingsTable } from '@/components/overview/SettingsTable'
import { TicketUsageTable, type UsageGrouping } from '@/components/overview/TicketUsageTable'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { queryKeys, useClaudeUsage, useOverview } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { useStoredState } from '@/hooks/use-stored-state'
import { api, errorMessage } from '@/lib/api'
import { formatBytes, formatCost, formatDateTime, formatDuration, formatModel, formatTokens } from '@/lib/format'
import {
  costPerCompletedTicket,
  dailyActivity,
  diskBytes,
  median,
  modelSeries,
  modelsByTokens,
  needsAttention,
  seriesTokens,
  workedByAgent,
} from '@/lib/overview'
import { sideTabIds } from '@/lib/side-tabs'
import { storageKeys } from '@/lib/storage'
import { cn } from '@/lib/utils'

const ACTIVITY_SERIES = [
  { kind: 'completed', label: 'Completed', color: 'var(--chart-1)' },
  { kind: 'created', label: 'Created', color: 'var(--chart-2)' },
  { kind: 'comment', label: 'Comments', color: 'var(--chart-3)' },
  { kind: 'update', label: 'Other updates', color: 'var(--chart-4)' },
] as const

const WORK_SERIES: ChartSeries[] = [{ label: 'Worked', color: 'var(--chart-1)' }]

const TOKEN_SERIES = [
  { key: 'outputTokens', label: 'Output', color: 'var(--chart-1)' },
  { key: 'inputTokens', label: 'Input', color: 'var(--chart-2)' },
  { key: 'cacheWriteTokens', label: 'Cache writes', color: 'var(--chart-3)' },
  { key: 'cacheReadTokens', label: 'Cache reads', color: 'var(--chart-4)' },
] as const

const HOUR_MS = 60 * 60 * 1000

/** The overview's tabs, in the order the side nav lists them; each has its own URL, `/overview/<id>`. */
const TABS = [
  { id: 'summary', label: 'Summary', icon: LayoutDashboardIcon },
  { id: 'agents', label: 'Agents', icon: BotIcon },
  { id: 'boards', label: 'Boards', icon: SquareKanbanIcon },
  { id: 'usage', label: 'Usage', icon: CoinsIcon },
  { id: 'routing', label: 'Routing', icon: RouteIcon },
  { id: 'activity', label: 'Activity', icon: ActivityIcon },
] as const

export type OverviewTab = (typeof TABS)[number]['id']

/** The tab a URL's `:tab` names; Summary for none or one that doesn't exist. */
function overviewTab(tab: string | undefined): OverviewTab {
  return TABS.find(({ id }) => id === tab)?.id ?? 'summary'
}

const tabHref = (tab: OverviewTab) => (tab === 'summary' ? '/overview' : `/overview/${tab}`)

/** How many entries of the activity feed Summary shows; the Activity tab has the rest. */
const SUMMARY_ACTIVITY = 8

/** The Activity tab's board filter value for every board. */
const ALL_BOARDS = 'all'

/** Tabs whose numbers don't depend on the 7/14/30-day range, so the range toggle isn't shown on them. */
const ALL_TIME_TABS: ReadonlySet<OverviewTab> = new Set(['routing'])

const ID_PREFIX = 'overview'
const NEEDS_ATTENTION_ID = `${ID_PREFIX}-needs-attention`

function CountBadge({ count }: { count: number }) {
  if (!count) return null
  return (
    <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
      {count}
    </span>
  )
}

interface StatProps {
  label: string
  value: ReactNode
  detail: ReactNode
  /** A second line of detail, if any. */
  more?: ReactNode
  /** The tab that breaks the number down, or an element on this tab, by `#id`. */
  target?: OverviewTab | `#${string}`
}

const STAT_CLASS = 'rounded-xl border bg-card p-4'
const STAT_LINK_CLASS = cn(
  STAT_CLASS,
  'transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
)

/** A headline number; its detail wraps rather than being cut off, so keep it short. */
function Stat({ label, value, detail, more, target }: StatProps) {
  const body = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      {more && <p className="text-xs text-muted-foreground">{more}</p>}
    </>
  )
  if (!target) return <div className={STAT_CLASS}>{body}</div>
  if (target.startsWith('#'))
    return (
      <a href={target} className={STAT_LINK_CLASS}>
        {body}
      </a>
    )
  return (
    <Link href={tabHref(target as OverviewTab)} className={STAT_LINK_CLASS}>
      {body}
    </Link>
  )
}

/** A word in a stat's value, set smaller than its numbers. */
function Unit({ children }: { children: ReactNode }) {
  return <span className="text-sm font-normal text-muted-foreground">{children}</span>
}

/** A tab's headline numbers: one row of four, two to a row on narrow screens. */
function StatRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
}

const runs = (count: number) => `${count} ${count === 1 ? 'run' : 'runs'}`

/** Each model's tokens, cost and runs over the range, most tokens first. */
function ModelTotals({ usage }: { usage: UsageTotals }) {
  const total = totalTokens(usage)
  return (
    <ul className="grid gap-1 border-t pt-3 text-xs">
      {modelsByTokens(usage).map((entry) => {
        const tokens = totalTokens(entry)
        return (
          <li key={entry.model} className="flex items-baseline gap-2" title={entry.model}>
            <span className="min-w-0 flex-1 truncate">{formatModel(entry.model)}</span>
            <span className="text-muted-foreground tabular-nums">
              {runs(entry.runs)}
              {entry.costUsd !== null && `, ${formatCost(entry.costUsd)}`}
            </span>
            <span className="w-12 text-right font-medium tabular-nums" title={`${tokens.toLocaleString()} tokens`}>
              {formatTokens(tokens)}
            </span>
            <span className="w-9 text-right text-muted-foreground tabular-nums">
              {total ? Math.round((tokens / total) * 100) : 0}%
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const tickets = (count: number) => `${count} ${count === 1 ? 'ticket' : 'tickets'}`

function formatMedian(values: number[]) {
  const value = median(values)
  return value === null ? '—' : formatDuration(value)
}

interface SectionProps {
  title: string
  id?: string
  /** Controls shown next to the title. */
  actions?: ReactNode
  children: ReactNode
  className?: string
}

function Section({ title, id, actions, children, className }: SectionProps) {
  return (
    <section id={id} className={cn('grid scroll-mt-6 grid-cols-1 content-start gap-3', className)}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** The disk space all boards take, and the agent folders of deleted boards that are left. */
function DiskTotal({ overview: { boards, disk } }: { overview: Overview }) {
  const total = boards.reduce((sum, board) => sum + diskBytes(board.disk), 0)
  return (
    <p
      className="text-xs text-muted-foreground"
      title={
        disk.measuredAt
          ? `Agent folders measured ${formatDateTime(disk.measuredAt)}`
          : 'The agent supervisor (scripts/install-services.sh) measures the agent folders where the agents run.'
      }
    >
      <span className="font-medium text-foreground tabular-nums">{formatBytes(total)}</span> on disk
      {disk.deletedBoards > 0 && `, ${formatBytes(disk.deletedBoards)} more in folders of deleted boards`}
    </p>
  )
}

export function OverviewPage({ tab: tabParam }: { tab?: string }) {
  const tab = overviewTab(tabParam)
  const [, navigate] = useLocation()
  const main = useRef<HTMLElement>(null)
  const [days, setDays] = useStoredState<OverviewRange>(storageKeys.overviewRange, 14)
  const [usageGrouping, setUsageGrouping] = useState<UsageGrouping>('tickets')
  const [activityBoard, setActivityBoard] = useState(ALL_BOARDS)
  const { data: overview, error, isPlaceholderData } = useOverview(days)
  const { data: claudeUsage } = useClaudeUsage()
  const now = useNow()
  const queryClient = useQueryClient()

  const tabLabel = TABS.find(({ id }) => id === tab)!.label
  useEffect(() => {
    document.title = `${tabLabel} · Overview · ultrakanban`
  }, [tabLabel])

  // Each tab starts at its top.
  useEffect(() => {
    main.current?.scrollTo({ top: 0 })
  }, [tab])

  // A failed refetch keeps the loaded overview: tell the user instead of replacing it.
  useEffect(() => {
    if (error && overview)
      toast.error(`Couldn’t refresh the overview: ${errorMessage(error)}`, { id: 'overview-refetch' })
  }, [error, overview])

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
  let badges: Partial<Record<OverviewTab, ReactNode>> = {}
  if (overview) {
    const { totals, agents, hiddenAgents } = overview
    // Idle agents that aren't a board's host agent are usually old or misspelled names.
    const stale = agents.filter((agent) => agent.status === 'idle' && !agent.agentOf.length).map((agent) => agent.name)
    const completed = daily.reduce((total, day) => total + day.events.completed, 0)
    const workedMs = daily.reduce((total, day) => total + day.workedMs, 0)
    const created = daily.reduce((total, day) => total + day.events.created, 0)
    const usage = daily.reduce((total, day) => mergeUsage(total, day.usage), noUsage())
    // What runs on the agents' API key spent is billed, so it is told apart from the plan's estimated cost.
    const apiKeyCost = daily.reduce((total, day) => total + day.apiKeyCostUsd, 0)
    const planCost = usage.costUsd === null ? null : Math.max(0, usage.costUsd - apiKeyCost)
    const models = modelSeries(usage, formatModel)
    const attention = needsAttention(agents, now)
    const unclaimed = totals.open - totals.working - totals.review
    const attentionCount = attention.waiting.length + attention.review.length + attention.stalled.length
    const backlog = created === completed ? '±0' : `${created > completed ? '+' : '−'}${Math.abs(created - completed)}`
    const completions = overview.completions.filter(
      (completion) => Date.parse(completion.at) >= daily[0].start.getTime(),
    )
    const completedCost = costPerCompletedTicket(completions)
    const cycleTimes = completions.flatMap((completion) => completion.cycleMs ?? [])
    const reviewTimes = completions.flatMap((completion) => completion.reviewMs ?? [])
    const columns = daily.map((day) => ({
      label: format(day.start, days === 7 ? 'EEE' : 'MMM d'),
      title: format(day.start, 'EEEE, MMM d'),
    }))

    const panels: Record<OverviewTab, ReactNode> = {
      summary: (
        <>
          <StatRow>
            <Stat
              label="Working"
              value={
                <>
                  <span className="whitespace-nowrap">
                    {totals.activeAgents} <Unit>{totals.activeAgents === 1 ? 'agent' : 'agents'} on</Unit>
                  </span>{' '}
                  <span className="whitespace-nowrap">
                    {totals.working} <Unit>{totals.working === 1 ? 'ticket' : 'tickets'}</Unit>
                  </span>
                </>
              }
              detail={`${totals.open} open, ${totals.review} in review`}
              target="agents"
            />
            <Stat
              label="Needs you"
              value={attentionCount}
              detail={
                attentionCount
                  ? [
                      attention.waiting.length && `${attention.waiting.length} to answer`,
                      attention.review.length && `${attention.review.length} to review`,
                      attention.stalled.length && `${attention.stalled.length} stalled`,
                    ]
                      .filter(Boolean)
                      .join(', ')
                  : 'Nothing waiting'
              }
              target={`#${NEEDS_ATTENTION_ID}`}
            />
            <Stat label="Completed" value={completed} detail={`Backlog ${backlog}`} target="activity" />
            <Stat
              label="Spent"
              value={usage.costUsd === null ? '—' : formatCost(usage.costUsd)}
              detail={`Estimated, ${runs(usage.runs)}`}
              more={apiKeyCost > 0 && `${formatCost(apiKeyCost)} on the API key`}
              target="usage"
            />
          </StatRow>
          <Section title="Needs attention" id={NEEDS_ATTENTION_ID}>
            <NeedsAttention
              waiting={attention.waiting}
              review={attention.review}
              stalled={attention.stalled}
              now={now}
            />
          </Section>
          {claudeUsage && <ClaudeUsageSummary usage={claudeUsage} now={now} href={tabHref('usage')} />}
          <Section
            title="Recent activity"
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link href={tabHref('activity')}>All activity</Link>
              </Button>
            }
          >
            <RecentActivity activity={overview.recent} limit={SUMMARY_ACTIVITY} />
          </Section>
        </>
      ),
      agents: (
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
      ),
      boards: (
        <>
          <StatRow>
            <Stat label="Unclaimed" value={unclaimed} detail="Open, unassigned" />
          </StatRow>
          <Section title="Boards" actions={<DiskTotal overview={overview} />}>
            <BoardTable boards={overview.boards} />
          </Section>
        </>
      ),
      usage: (
        <>
          {claudeUsage && <ClaudeUsage usage={claudeUsage} now={now} />}
          <StatRow>
            <Stat
              label="Tokens used"
              value={formatTokens(totalTokens(usage))}
              detail={planCost === null ? runs(usage.runs) : `${formatCost(planCost)} est., ${runs(usage.runs)}`}
              more={apiKeyCost > 0 && `${formatCost(apiKeyCost)} on the API key`}
            />
            <Stat
              label="Per completed ticket"
              value={completedCost ? formatCost(completedCost.costUsd) : '—'}
              detail={completedCost ? `Est., ${tickets(completedCost.tickets)}` : 'None reported a cost'}
            />
          </StatRow>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <ColumnChart
              title="Token usage"
              description="Tokens agent runs used per day, as reported by the agent loop"
              series={[...TOKEN_SERIES]}
              columns={daily.map((day, i) => ({
                ...columns[i],
                values: TOKEN_SERIES.map((series) => day.usage[series.key]),
              }))}
              formatValue={(value) => value.toLocaleString()}
              formatTick={formatTokens}
              minStep={1}
            />
            <ColumnChart
              title="Tokens by model"
              description="Tokens per day by the model that used them, subagents included"
              series={models}
              columns={daily.map((day, i) => ({
                ...columns[i],
                values: models.map((series) => seriesTokens(day.usage, series)),
              }))}
              formatValue={(value) => value.toLocaleString()}
              formatTick={formatTokens}
              minStep={1}
              footer={models.length > 0 && <ModelTotals usage={usage} />}
            />
          </div>
          <Section
            title="Ticket usage"
            actions={
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={usageGrouping}
                onValueChange={(value) => value && setUsageGrouping(value as UsageGrouping)}
                aria-label="Group by"
              >
                <ToggleGroupItem value="tickets" className="px-3">
                  Tickets
                </ToggleGroupItem>
                <ToggleGroupItem value="tags" className="px-3">
                  By tag
                </ToggleGroupItem>
              </ToggleGroup>
            }
          >
            <p className="-mt-1 text-xs text-muted-foreground">
              Tickets agents ran on in the last {days} days, with all their runs
            </p>
            <TicketUsageTable tickets={overview.tickets} grouping={usageGrouping} />
          </Section>
        </>
      ),
      routing: (
        <>
          <Section title="Routing">
            <p className="-mt-1 text-xs text-muted-foreground">
              Cost per finished ticket had each source picked every ticket’s model and effort, on all boards since
              routing was recorded
            </p>
            <RoutingTable routing={overview.routing} />
          </Section>
          <Section title="Model and effort">
            <p className="-mt-1 text-xs text-muted-foreground">
              How tickets went at the model and effort that did most of their work, on all boards over all time
            </p>
            <SettingsTable settings={overview.settings} />
          </Section>
        </>
      ),
      activity: (
        <>
          <StatRow>
            <Stat label="Time worked" value={formatDuration(workedMs)} detail="All agents" />
            <Stat
              label="Median cycle time"
              value={formatMedian(cycleTimes)}
              detail={`Over ${tickets(cycleTimes.length)}`}
            />
            <Stat
              label="Median review wait"
              value={formatMedian(reviewTimes)}
              detail={`Over ${tickets(reviewTimes.length)}`}
            />
            <Stat label="Backlog" value={backlog} detail={`${created} new, ${completed} done`} />
          </StatRow>
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
          <Section
            title="Recent activity"
            actions={
              <Select value={activityBoard} onValueChange={setActivityBoard}>
                <SelectTrigger aria-label="Board" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_BOARDS}>All boards</SelectItem>
                  {overview.boards.map((board) => (
                    <SelectItem key={board.id} value={board.id}>
                      {board.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          >
            <RecentActivity
              activity={
                activityBoard === ALL_BOARDS
                  ? overview.recent
                  : overview.recent.filter((entry) => entry.ticket.boardId === activityBoard)
              }
            />
          </Section>
        </>
      ),
    }

    badges = {
      summary: <CountBadge count={attentionCount} />,
      agents: <CountBadge count={totals.activeAgents} />,
    }
    content = (
      <div className={cn('grid grid-cols-1 gap-6 transition-opacity', isPlaceholderData && 'opacity-60')}>
        {panels[tab]}
      </div>
    )
  } else if (error) {
    content = <p className="text-sm text-muted-foreground">Couldn’t load the overview: {error.message}</p>
  }

  const ids = sideTabIds(ID_PREFIX, tab)
  return (
    <>
      <AppHeader />
      <main ref={main} className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-5 p-4 sm:p-6">
          <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
              <p className="text-sm text-muted-foreground">What’s happening across all boards.</p>
            </div>
            {!ALL_TIME_TABS.has(tab) && range}
          </div>
          <div className="flex flex-col gap-5 sm:flex-row sm:gap-6">
            <SideTabs
              tabs={TABS}
              active={tab}
              onSelect={(id) => navigate(tabHref(id))}
              idPrefix={ID_PREFIX}
              label="Overview sections"
              badges={badges}
              className="-mx-4 px-4 sm:sticky sm:top-6 sm:mx-0 sm:self-start sm:border-r-0 sm:p-0"
            />
            <div id={ids.panel} role="tabpanel" aria-labelledby={ids.tab} className="min-w-0 flex-1">
              {content}
            </div>
          </div>
        </div>
      </main>
    </>
  )
}
