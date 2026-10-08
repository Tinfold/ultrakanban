import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Route, Switch } from 'wouter'
import { ThemeProvider } from '@/components/app/ThemeProvider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useLiveUpdates } from '@/hooks/use-live-updates'
import { BoardPage } from '@/pages/BoardPage'
import { HomePage } from '@/pages/HomePage'
import { OverviewPage } from '@/pages/OverviewPage'
import { SetupPage } from '@/pages/SetupPage'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true } },
})

function Routes() {
  useLiveUpdates()
  return (
    <div className="flex h-dvh flex-col">
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/overview" component={OverviewPage} />
        <Route path="/setup" component={SetupPage} />
        <Route path="/b/:boardId">{({ boardId }) => <BoardPage key={boardId} boardId={boardId} />}</Route>
        <Route>
          <HomePage />
        </Route>
      </Switch>
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={400}>
          <Routes />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
