import {
  BellIcon,
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  GitPullRequestIcon,
  PlusIcon,
  Settings2Icon,
} from 'lucide-react'
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link } from 'wouter'
import { useBoardContext } from '@/components/board/board-context'
import { CreateGitHubRepoDialog } from '@/components/boards/CreateGitHubRepoDialog'
import { ColorDot } from '@/components/common/TagChip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useGitHubStatus, useSetup } from '@/hooks/queries'
import type { BoardPatch } from '@/lib/board-updates'
import { cn } from '@/lib/utils'
import {
  AGENT_DEFAULTS,
  AGENT_EFFORTS,
  AGENT_MAX_CONCURRENCY,
  AGENT_MODELS,
  type AgentEffort,
  type AgentModelAlias,
  agentWorkerName,
  type BoardSummary,
  JEV_DEFAULTS,
  type JevCombine,
  type JevMode,
  TICKET_SIZES,
  type TicketSize,
} from '@shared/domain'

const NONE = '__none'
const DEFAULT_EFFORT = '__default'
const DEFAULT_CONCURRENCY = '__default'

/** Choices for which estimated sizes the agent waits for approval on, by the smallest one held. */
const APPROVAL_CHOICES: Record<TicketSize, string> = {
  L: 'Large (L) tickets',
  M: 'Medium and large (M, L) tickets',
  S: 'Every ticket',
}

function ColumnSelect({ id, name, value }: { id: string; name: string; value: string | null }) {
  const { detail } = useBoardContext()
  return (
    <Select name={name} defaultValue={value ?? NONE}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>None</SelectItem>
        {detail.columns.map((column) => (
          <SelectItem key={column.id} value={column.id}>
            <ColorDot color={column.color} />
            {column.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function GitHubStatus() {
  const { data } = useGitHubStatus()
  if (!data) return null
  if (data.auth) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleCheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        Checking pull requests on GitHub using{' '}
        {data.auth === 'gh' ? 'your gh CLI login' : data.auth === 'board' ? 'the token from Setup' : 'GITHUB_TOKEN'}.
      </p>
    )
  }
  return (
    <p className="flex gap-1.5 text-xs text-muted-foreground">
      <CircleAlertIcon className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <span>
        Not signed in to GitHub, so only public repositories can be checked.{' '}
        <Link href="/setup" className="text-foreground underline underline-offset-2">
          Add a token in Setup
        </Link>
        .
      </span>
    </p>
  )
}

/** The dialog's sections, in the order the navigation lists them. */
const SECTIONS = [
  { id: 'general', label: 'General', icon: Settings2Icon },
  { id: 'pullRequests', label: 'Pull requests', icon: GitPullRequestIcon },
  { id: 'agent', label: 'Agent', icon: BotIcon },
  { id: 'notifications', label: 'Notifications', icon: BellIcon },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

function Section({
  id,
  active,
  title,
  description,
  children,
}: {
  id: SectionId
  active: SectionId
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  // Every section stays mounted, so the form saves the fields of the hidden ones too.
  return (
    <div
      id={`board-settings-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`board-settings-tab-${id}`}
      data-section={id}
      hidden={id !== active}
      className="grid gap-5"
    >
      <div className="grid gap-1">
        <h3 className="text-base font-medium">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  )
}

/** A titled group of related fields within a section. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-3 border-t pt-4">
      <legend className="float-left mb-1 w-full text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  )
}

function Hint({ children, indent }: { children: ReactNode; indent?: boolean }) {
  return <p className={cn('text-xs text-muted-foreground', indent && 'pl-6')}>{children}</p>
}

function CheckboxField({
  name,
  label,
  defaultChecked,
  onChange,
  children,
}: {
  name: string
  label: ReactNode
  defaultChecked: boolean
  onChange?: (checked: boolean) => void
  children?: ReactNode
}) {
  return (
    <div className="grid gap-1">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          onChange={onChange && ((event) => onChange(event.target.checked))}
          className="size-4 accent-primary"
        />
        {label}
      </label>
      {children && <Hint indent>{children}</Hint>}
    </div>
  )
}

export function BoardSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(44rem,90dvh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b p-4">
          <DialogTitle>Board settings</DialogTitle>
          <DialogDescription className="sr-only">
            The board's name and description, pull request workflow, agent and notifications.
          </DialogDescription>
        </DialogHeader>
        <BoardSettingsForm onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

type JevSettings = Pick<
  BoardSummary,
  'jevEnabled' | 'jevModels' | 'jevThreshold' | 'jevOnlyLower' | 'jevCombine' | 'jevMode'
>

/** The board's "Route with Jev" settings (see docs/JEV.md); greyed out and not saved without a TypeSafe API key. */
function JevFieldset({
  value,
  onChange,
  disabled,
}: {
  value: JevSettings
  onChange: (value: JevSettings) => void
  disabled: boolean
}) {
  const models = value.jevModels ?? [...AGENT_MODELS]
  const toggleModel = (model: AgentModelAlias, checked: boolean) => {
    const next = AGENT_MODELS.filter((each) => (each === model ? checked : models.includes(each)))
    if (next.length) onChange({ ...value, jevModels: next.length === AGENT_MODELS.length ? null : next })
  }
  return (
    <fieldset disabled={disabled} className="grid gap-5 border-t pt-5 disabled:opacity-50">
      <legend className="sr-only">Route with Jev</legend>
      <div className="grid gap-1">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={value.jevEnabled}
            onChange={(event) =>
              onChange({
                ...value,
                jevEnabled: event.target.checked,
                jevMode: value.jevMode ?? (event.target.checked ? JEV_DEFAULTS.mode : null),
              })
            }
            className="size-4 accent-primary"
          />
          Route with Jev
        </label>
        <p className="pl-6 text-xs text-muted-foreground">
          Jev (TypeSafe) picks the model and effort for tickets that don't set their own.
          {disabled && ' Needs a TypeSafe API key.'}
        </p>
      </div>
      {value.jevEnabled && (
        <>
          <div className="grid gap-2">
            <Label htmlFor="board-settings-jev-mode">Mode</Label>
            <Select
              value={value.jevMode ?? JEV_DEFAULTS.mode}
              onValueChange={(mode) => onChange({ ...value, jevMode: mode as JevMode })}
            >
              <SelectTrigger id="board-settings-jev-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="dry-run">Dry run — record Jev's picks only</SelectItem>
                <SelectItem value="on">On — work tickets at Jev's pick</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Models Jev may pick</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {AGENT_MODELS.map((model) => (
                <label key={model} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={models.includes(model)}
                    onChange={(event) => toggleModel(model, event.target.checked)}
                    className="size-4 accent-primary"
                  />
                  {model}
                </label>
              ))}
            </div>
          </div>
          <details className="rounded-md border p-3 [&>div]:mt-4">
            <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
            <div className="grid gap-1">
              <div className="flex items-center gap-2 text-sm">
                <Label htmlFor="board-settings-jev-threshold" className="font-normal">
                  Use its pick from a confidence of
                </Label>
                <Input
                  id="board-settings-jev-threshold"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={value.jevThreshold ?? ''}
                  onChange={(event) => {
                    const threshold = event.target.value === '' ? null : Number(event.target.value)
                    onChange({
                      ...value,
                      jevThreshold: threshold === null || Number.isNaN(threshold) ? null : threshold,
                    })
                  }}
                  placeholder={String(JEV_DEFAULTS.threshold)}
                  className="h-7 w-20"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Below it, the similar-tickets suggestion or board setting is used.
              </p>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="board-settings-jev-combine">When Jev and the similar-tickets suggestion disagree</Label>
              <Select
                value={value.jevCombine ?? JEV_DEFAULTS.combine}
                onValueChange={(combine) =>
                  onChange({ ...value, jevCombine: combine === JEV_DEFAULTS.combine ? null : (combine as JevCombine) })
                }
              >
                <SelectTrigger id="board-settings-jev-combine" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="jev-only">Use Jev only</SelectItem>
                  <SelectItem value="jev-first">Prefer Jev (fall back to similar tickets)</SelectItem>
                  <SelectItem value="higher">Use the higher setting</SelectItem>
                  <SelectItem value="lower">Use the lower setting</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The similar-tickets suggestion is what similar finished tickets used.
              </p>
            </div>
            <div className="grid gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value.jevOnlyLower}
                  onChange={(event) => onChange({ ...value, jevOnlyLower: event.target.checked })}
                  className="size-4 accent-primary"
                />
                Only pick cheaper settings
              </label>
              <p className="pl-6 text-xs text-muted-foreground">Never above the board's agent setting.</p>
            </div>
          </details>
        </>
      )}
    </fieldset>
  )
}

type FixRuns = Pick<BoardSummary, 'agentConflictModel' | 'agentConflictEffort' | 'agentCiModel' | 'agentCiEffort'>

/** Model and effort fields for one kind of fix run (merge conflicts or failing CI); empty is the default. */
function FixRunFields({
  id,
  label,
  model,
  effort,
  defaults,
  onChange,
}: {
  id: string
  label: string
  model: string | null
  effort: AgentEffort | null
  defaults: { model: string; effort: AgentEffort }
  onChange: (model: string | null, effort: AgentEffort | null) => void
}) {
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={`board-settings-${id}-model`}>{label} model</Label>
        <Input
          id={`board-settings-${id}-model`}
          value={model ?? ''}
          placeholder={defaults.model}
          pattern="[\w.:\[\]\-]+(/[\w.:\[\]\-]+)*"
          maxLength={100}
          title="A model alias or name, e.g. sonnet, claude-sonnet-5-5 or qwen3-coder:30b"
          onChange={(event) => onChange(event.target.value.trim() || null, effort)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`board-settings-${id}-effort`}>{label} effort</Label>
        <Select
          value={effort ?? DEFAULT_EFFORT}
          onValueChange={(value) => onChange(model, value === DEFAULT_EFFORT ? null : (value as AgentEffort))}
        >
          <SelectTrigger id={`board-settings-${id}-effort`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_EFFORT}>Default ({defaults.effort})</SelectItem>
            {AGENT_EFFORTS.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  )
}

/** Mounted with the dialog's content, so it starts from the saved settings each time the dialog opens. */
function BoardSettingsForm({ onClose }: { onClose: () => void }) {
  const { detail, actions } = useBoardContext()
  const [section, setSection] = useState<SectionId>('general')
  const [agent, setAgent] = useState(() => {
    const { agentName, agentModel, agentEffort } = detail.board
    return { agentName, agentModel, agentEffort }
  })
  const [agentEnabled, setAgentEnabled] = useState(detail.board.agentEnabled)
  const [agentConcurrency, setAgentConcurrency] = useState(detail.board.agentConcurrency)
  const [agentConflictConcurrency, setAgentConflictConcurrency] = useState(detail.board.agentConflictConcurrency)
  const [fixRuns, setFixRuns] = useState<FixRuns>(() => {
    const { agentConflictModel, agentConflictEffort, agentCiModel, agentCiEffort } = detail.board
    return { agentConflictModel, agentConflictEffort, agentCiModel, agentCiEffort }
  })
  const [githubRepo, setGithubRepo] = useState(detail.board.githubRepo ?? '')
  const [notifyUrl, setNotifyUrl] = useState(detail.board.notifyUrl ?? '')
  const [creatingRepo, setCreatingRepo] = useState(false)
  const signedIn = !!useGitHubStatus().data?.auth
  const hasBacklog = detail.columns.some((column) => column.name.toLowerCase() === 'backlog')
  const hasTypesafeKey = !!useSetup().data?.typesafe.source
  const [jev, setJev] = useState<JevSettings>(() => {
    const { jevEnabled, jevModels, jevThreshold, jevOnlyLower, jevCombine, jevMode } = detail.board
    return { jevEnabled, jevModels, jevThreshold, jevOnlyLower, jevCombine, jevMode }
  })
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const form = useRef<HTMLFormElement>(null)
  const content = useRef<HTMLDivElement>(null)

  // Each section starts at its top, and on narrow screens its tab scrolls into view.
  useEffect(() => {
    content.current?.scrollTo({ top: 0 })
    tabs.current[SECTIONS.findIndex(({ id }) => id === section)]?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [section])

  // A field the browser finds invalid on Save may be in a hidden section, where it can't show why: switch to the
  // section of the first one, so the browser can focus it and show its message.
  useEffect(() => {
    const element = form.current
    if (!element) return
    let switched = false
    const onInvalid = (event: Event) => {
      if (switched) return
      switched = true
      queueMicrotask(() => (switched = false))
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-section]')?.dataset.section
      if (target) flushSync(() => setSection(target as SectionId))
    }
    element.addEventListener('invalid', onInvalid, true)
    return () => element.removeEventListener('invalid', onInvalid, true)
  }, [])

  const badges: Partial<Record<SectionId, ReactNode>> = {
    agent: <StatusBadge on={agentEnabled} />,
    notifications: <StatusBadge on={!!notifyUrl.trim()} />,
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? SECTIONS.length - 1
          : step
            ? (index + step + SECTIONS.length) % SECTIONS.length
            : null
    if (next === null) return
    event.preventDefault()
    setSection(SECTIONS[next].id)
    tabs.current[next]?.focus()
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const name = String(data.get('name') ?? '').trim()
    if (!name) return
    const columnId = (field: string) => {
      const value = String(data.get(field) ?? NONE)
      return value === NONE ? null : value
    }
    const text = (field: string) => String(data.get(field) ?? '').trim() || null
    const archiveDays = Number(text('archiveDoneDays'))
    const maxTurns = Number(text('agentMaxTurns'))
    const approvalSize = String(data.get('approvalSize') ?? NONE)
    // Left alone without a key, as the settings aren't shown then.
    const jevPatch: BoardPatch = hasTypesafeKey ? jev : {}
    void actions.updateBoard({
      ...jevPatch,
      name,
      description: String(data.get('description') ?? ''),
      reviewColumnId: columnId('reviewColumn'),
      doneColumnId: columnId('doneColumn'),
      githubRepo: text('githubRepo'),
      agentName: text('agentName'),
      agentModel: text('agentModel'),
      agentEffort: agent.agentEffort,
      agentConcurrency,
      agentMaxTurns: maxTurns >= 1 ? Math.round(maxTurns) : null,
      agentConflictConcurrency,
      ...fixRuns,
      agentEnabled: data.get('agentEnabled') === 'on',
      agentBacklog: data.get('agentBacklog') === 'on',
      agentAllSkills: data.get('agentAllSkills') === 'on',
      agentDocker: data.get('agentDocker') === 'on',
      autoMerge: data.get('autoMerge') === 'on',
      ignoreBillingFailures: data.get('ignoreBillingFailures') === 'on',
      deleteMergedBranches: data.get('deleteMergedBranches') === 'on',
      archiveDoneDays: archiveDays >= 1 ? Math.round(archiveDays) : null,
      approvalSize: approvalSize === NONE ? null : (approvalSize as TicketSize),
      notifyUrl: text('notifyUrl'),
    })
    onClose()
  }

  return (
    <form ref={form} onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0"
        >
          {SECTIONS.map(({ id, label, icon: Icon }, index) => (
            <button
              key={id}
              ref={(element) => {
                tabs.current[index] = element
              }}
              id={`board-settings-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={section === id}
              aria-controls={`board-settings-panel-${id}`}
              tabIndex={section === id ? 0 : -1}
              onClick={() => setSection(id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                section === id && 'bg-muted font-medium text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {badges[id]}
            </button>
          ))}
        </nav>

        <div ref={content} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <Section id="general" active={section} title="General">
            <div className="grid gap-2">
              <Label htmlFor="board-settings-name">Name</Label>
              <Input id="board-settings-name" name="name" required defaultValue={detail.board.name} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="board-settings-description">Description</Label>
              <Textarea
                id="board-settings-description"
                name="description"
                rows={6}
                className="min-h-32"
                defaultValue={detail.board.description}
                placeholder="What is this board for? Conventions for agents?"
              />
              <Hint>
                Agents read it with the board: say what the board is for and the conventions every ticket on it should
                follow.
              </Hint>
            </div>
          </Section>

          <Section
            id="pullRequests"
            active={section}
            title="Pull requests"
            description="Agents submit tickets to the review column with their GitHub pull request. Tickets only enter the done column once that pull request is merged, and move there automatically when it is."
          >
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="board-settings-repo">GitHub repository</Label>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto p-0"
                  disabled={!signedIn}
                  title={signedIn ? 'Create a repository on GitHub for this board' : 'Sign in to GitHub first'}
                  onClick={() => setCreatingRepo(true)}
                >
                  <PlusIcon />
                  New
                </Button>
              </div>
              <Input
                id="board-settings-repo"
                name="githubRepo"
                value={githubRepo}
                onChange={(event) => setGithubRepo(event.target.value)}
                placeholder="owner/name"
                pattern="[\w.\-]+/[\w.\-]+"
                title="owner/name"
              />
              <Hint>The agent works in its own clone of this repository and opens its pull requests there.</Hint>
              <GitHubStatus />
            </div>

            <Group title="Columns">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="board-settings-review">Review column</Label>
                  <ColumnSelect id="board-settings-review" name="reviewColumn" value={detail.board.reviewColumnId} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="board-settings-done">Done column</Label>
                  <ColumnSelect id="board-settings-done" name="doneColumn" value={detail.board.doneColumnId} />
                </div>
              </div>
              <div className="grid gap-1">
                <div className="flex items-center gap-2 text-sm">
                  <Label htmlFor="board-settings-archive" className="font-normal">
                    Archive done tickets after
                  </Label>
                  <Input
                    id="board-settings-archive"
                    name="archiveDoneDays"
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    defaultValue={detail.board.archiveDoneDays ?? ''}
                    placeholder="never"
                    className="h-7 w-20"
                  />
                  days
                </div>
                <Hint>
                  Hides tickets that have been in the done column that long, and leaves them out of the board agents
                  read. Search still finds them, and Filter can show them. Leave empty to keep them all.
                </Hint>
              </div>
            </Group>

            <Group title="Merging">
              <CheckboxField
                name="autoMerge"
                label="Merge ready pull requests automatically"
                defaultChecked={detail.board.autoMerge}
              >
                Merges pull requests in the review column once they have no conflicts, every check has passed and every
                checklist item of their ticket is checked, the way Merge all would. Checks when pull requests are synced
                with GitHub.
              </CheckboxField>
              <CheckboxField
                name="ignoreBillingFailures"
                label="Ignore checks that failed because of billing"
                defaultChecked={detail.board.ignoreBillingFailures}
              >
                Counts a pull request as ready to merge when its only failing checks didn't run because of the account's
                billing, such as GitHub Actions jobs not started for a spending limit or failed payment. Any other
                failing or running check still holds it back, and branch protection may still refuse the merge.
              </CheckboxField>
              <CheckboxField
                name="deleteMergedBranches"
                label="Delete branches after merge"
                defaultChecked={detail.board.deleteMergedBranches}
              >
                Deletes a pull request's branch on GitHub once it is merged, however it was merged. Pull requests based
                on the branch move to its base first. Keeps branches in forks, the default branch and branches with
                commits pushed after the merge.
              </CheckboxField>
            </Group>
          </Section>

          <Section
            id="agent"
            active={section}
            title="Agent"
            description="The agent service on the host can work this board: it claims tickets, opens pull requests in its own clone of the repository and answers review feedback. It runs Claude Code without permission prompts."
          >
            <CheckboxField
              name="agentEnabled"
              label={<span className="font-medium">Run the agent on this board</span>}
              defaultChecked={detail.board.agentEnabled}
              onChange={setAgentEnabled}
            >
              {!githubRepo.trim() && <>It needs a GitHub repository, set under Pull requests.</>}
            </CheckboxField>

            <Group title="Model">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="board-settings-agent-name">Agent name</Label>
                  <Input
                    id="board-settings-agent-name"
                    name="agentName"
                    defaultValue={detail.board.agentName ?? ''}
                    placeholder={AGENT_DEFAULTS.name}
                    pattern="[\w.\-]{1,64}"
                    onChange={(event) => setAgent({ ...agent, agentName: event.target.value.trim() || null })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="board-settings-agent-model">Model</Label>
                  <Input
                    id="board-settings-agent-model"
                    name="agentModel"
                    defaultValue={detail.board.agentModel ?? ''}
                    placeholder={AGENT_DEFAULTS.model}
                    pattern="[\w.:\[\]\-]+(/[\w.:\[\]\-]+)*"
                    maxLength={100}
                    title="A model alias or name, e.g. opus, claude-opus-5-5 or qwen3-coder:30b"
                    onChange={(event) => setAgent({ ...agent, agentModel: event.target.value.trim() || null })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="board-settings-agent-effort">Effort</Label>
                  <Select
                    value={agent.agentEffort ?? DEFAULT_EFFORT}
                    onValueChange={(value) =>
                      setAgent({ ...agent, agentEffort: value === DEFAULT_EFFORT ? null : (value as AgentEffort) })
                    }
                  >
                    <SelectTrigger id="board-settings-agent-effort" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_EFFORT}>Default ({AGENT_DEFAULTS.effort})</SelectItem>
                      {AGENT_EFFORTS.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                          {effort}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Hint>
                It claims tickets as <code>{agentWorkerName(agent)}</code>. A full model name, such as claude-opus-5-5,
                keeps each model version apart on the board. A local model or another provider's, such as
                qwen3-coder:30b, works once Claude Code where the agent runs is pointed at an endpoint that serves it
                (docs/agents.md).
              </Hint>
            </Group>

            <Group title="Capacity">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid content-start gap-2">
                  <Label htmlFor="board-settings-agent-concurrency">Parallel runs</Label>
                  <Select
                    value={String(agentConcurrency ?? DEFAULT_CONCURRENCY)}
                    onValueChange={(value) => setAgentConcurrency(value === DEFAULT_CONCURRENCY ? null : Number(value))}
                  >
                    <SelectTrigger id="board-settings-agent-concurrency" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_CONCURRENCY}>Default ({AGENT_DEFAULTS.concurrency})</SelectItem>
                      {Array.from({ length: AGENT_MAX_CONCURRENCY }, (_, index) => String(index + 1)).map((count) => (
                        <SelectItem key={count} value={count}>
                          {count}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Hint>
                    Tickets worked at once, each in its own git worktree, all on the same Claude usage or endpoint.
                  </Hint>
                </div>
                <div className="grid content-start gap-2">
                  <Label htmlFor="board-settings-agent-max-turns">Max turns per run</Label>
                  <Input
                    id="board-settings-agent-max-turns"
                    name="agentMaxTurns"
                    type="number"
                    min={1}
                    max={10000}
                    step={1}
                    defaultValue={detail.board.agentMaxTurns ?? ''}
                    placeholder="no limit"
                  />
                </div>
                <div className="grid content-start gap-2">
                  <Label htmlFor="board-settings-agent-conflict-concurrency">Parallel conflict fixes</Label>
                  <Select
                    value={String(agentConflictConcurrency ?? DEFAULT_CONCURRENCY)}
                    onValueChange={(value) =>
                      setAgentConflictConcurrency(value === DEFAULT_CONCURRENCY ? null : Number(value))
                    }
                  >
                    <SelectTrigger id="board-settings-agent-conflict-concurrency" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_CONCURRENCY}>
                        Default ({AGENT_DEFAULTS.conflictConcurrency})
                      </SelectItem>
                      {Array.from({ length: AGENT_MAX_CONCURRENCY + 1 }, (_, index) => String(index)).map((count) => (
                        <SelectItem key={count} value={count}>
                          {count === '0' ? 'None' : count}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Hint>
                    More runs, each in a worktree of its own, that only fix the merge conflicts of its pull requests, so
                    the conflicts that merging one causes in the others are fixed side by side while the parallel runs
                    go on with their tickets.
                  </Hint>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FixRunFields
                  id="conflict"
                  label="Conflict fix"
                  model={fixRuns.agentConflictModel}
                  effort={fixRuns.agentConflictEffort}
                  defaults={{ model: AGENT_DEFAULTS.conflictModel, effort: AGENT_DEFAULTS.conflictEffort }}
                  onChange={(model, effort) =>
                    setFixRuns({ ...fixRuns, agentConflictModel: model, agentConflictEffort: effort })
                  }
                />
                <FixRunFields
                  id="ci"
                  label="CI fix"
                  model={fixRuns.agentCiModel}
                  effort={fixRuns.agentCiEffort}
                  defaults={{ model: AGENT_DEFAULTS.ciModel, effort: AGENT_DEFAULTS.ciEffort }}
                  onChange={(model, effort) => setFixRuns({ ...fixRuns, agentCiModel: model, agentCiEffort: effort })}
                />
              </div>
              <Hint>
                Runs started only to fix merge conflicts, or only to fix failing CI, use these instead of the ticket's
                model and effort, as they rarely need it. A run that also answers someone's feedback keeps the ticket's.
              </Hint>
            </Group>

            <Group title="Picking tickets">
              <CheckboxField
                name="agentBacklog"
                label="Take tickets from Backlog when Todo is empty"
                defaultChecked={detail.board.agentBacklog}
              >
                {hasBacklog
                  ? 'From either column it takes the highest priority first, then the earliest due date, then the ticket nearest the top.'
                  : 'This board has no column named Backlog.'}
              </CheckboxField>
              <div className="grid gap-2">
                <Label htmlFor="board-settings-approval">Wait for approval of the plan on</Label>
                <Select name="approvalSize" defaultValue={detail.board.approvalSize ?? NONE}>
                  <SelectTrigger id="board-settings-approval" className="w-full sm:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No tickets</SelectItem>
                    {[...TICKET_SIZES].reverse().map((size) => (
                      <SelectItem key={size} value={size}>
                        {APPROVAL_CHOICES[size]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Hint>
                  The agent posts a short plan with a size estimate (S, M or L) when it starts a ticket. Tickets
                  estimated at these sizes wait until someone approves the plan on the ticket, before the agent spends
                  more tokens on them.
                </Hint>
              </div>
            </Group>

            <Group title="Runs">
              <CheckboxField
                name="agentDocker"
                label="Run the agent in Docker containers"
                defaultChecked={detail.board.agentDocker}
              >
                Each run works in a throwaway container with only its checkout and the agent's Claude, GitHub and git
                settings, instead of directly on the machine. A ticket can choose otherwise. Needs Docker on the
                machine.
              </CheckboxField>
              <CheckboxField
                name="agentAllSkills"
                label="Load all skills in agent runs"
                defaultChecked={detail.board.agentAllSkills}
              >
                Off, runs only get the ultrakanban skill, unless the repository has skills of its own. Every skill is
                listed in each request a run makes, which costs tokens.
              </CheckboxField>
            </Group>
            <JevFieldset value={jev} onChange={setJev} disabled={!hasTypesafeKey} />
          </Section>

          <Section
            id="notifications"
            active={section}
            title="Notifications"
            description="Sends a message when a ticket needs you: an agent asks a question, CI needs someone to look at it, a plan waits for approval, a question is answered or a pull request is ready to merge."
          >
            <div className="grid gap-2">
              <Label htmlFor="board-settings-notify">Notify at</Label>
              <Input
                id="board-settings-notify"
                name="notifyUrl"
                type="url"
                value={notifyUrl}
                onChange={(event) => setNotifyUrl(event.target.value)}
                placeholder="https://ntfy.sh/your-topic"
              />
              <Hint>
                Takes an ntfy topic, a Discord webhook or any other webhook URL, which gets the notification as JSON.
                Leave empty to send nothing.
              </Hint>
            </div>
          </Section>
        </div>
      </div>

      <DialogFooter className="mx-0 mb-0">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
      <CreateGitHubRepoDialog open={creatingRepo} onOpenChange={setCreatingRepo} onCreated={setGithubRepo} />
    </form>
  )
}

/** Whether a section's feature is on, next to its name in the navigation. */
function StatusBadge({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 text-[10px] leading-4 font-medium',
        on ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted-foreground/10',
      )}
    >
      {on ? 'On' : 'Off'}
    </span>
  )
}
