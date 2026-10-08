import { ChartColumnIcon, SettingsIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useRoute } from 'wouter'
import { BoardSwitcher } from '@/components/boards/BoardSwitcher'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSetup } from '@/hooks/queries'
import { cn } from '@/lib/utils'
import { ActorMenu } from './ActorMenu'
import { ThemeToggle } from './ThemeToggle'
import { UpdateMenu } from './UpdateMenu'

export function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <rect x="2" y="3" width="5.5" height="18" rx="1.75" fill="currentColor" />
      <rect x="9.25" y="3" width="5.5" height="12" rx="1.75" fill="currentColor" opacity=".6" />
      <rect x="16.5" y="3" width="5.5" height="7" rx="1.75" fill="currentColor" opacity=".3" />
    </svg>
  )
}

function OverviewLink() {
  const [active] = useRoute('/overview')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon-sm" className={cn(active && 'bg-muted')}>
          <Link href="/overview" aria-label="Overview" aria-current={active ? 'page' : undefined}>
            <ChartColumnIcon />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Overview of all boards</TooltipContent>
    </Tooltip>
  )
}

/** Marked while the board has no working GitHub token, or the agents are missing a login. */
function SetupLink() {
  const [active] = useRoute('/setup')
  const { data: setup } = useSetup()
  const agents = setup?.agents
  const missing =
    !!setup && (!setup.github.login || (!!agents?.seenAt && (!agents.githubLogin || !agents.claudeAccount)))
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon-sm" className={cn('relative', active && 'bg-muted')}>
          <Link href="/setup" aria-label="Setup" aria-current={active ? 'page' : undefined}>
            <SettingsIcon />
            {missing && <span className="absolute top-1 right-1 size-2 rounded-full bg-primary" />}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{missing ? 'Finish the setup: GitHub and Claude logins' : 'Setup'}</TooltipContent>
    </Tooltip>
  )
}

export function AppHeader({ boardId, children }: { boardId?: string; children?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2 sm:px-3">
      <Link
        href="/"
        aria-label="ultrakanban home"
        className="flex size-8 shrink-0 items-center justify-center rounded-md"
      >
        <Logo />
      </Link>
      <span className="text-muted-foreground/40" aria-hidden>
        /
      </span>
      <BoardSwitcher currentBoardId={boardId} />
      {children}
      <div className="ml-auto flex items-center gap-0.5">
        <UpdateMenu />
        <OverviewLink />
        <SetupLink />
        <ThemeToggle />
        <ActorMenu />
      </div>
    </header>
  )
}
