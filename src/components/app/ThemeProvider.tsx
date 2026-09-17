import { type ReactNode, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useStoredState } from '@/hooks/use-stored-state'
import { storageKeys } from '@/lib/storage'
import { type Theme, ThemeContext } from './theme-context'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

const subscribeSystem = (listener: () => void) => {
  darkQuery.addEventListener('change', listener)
  return () => darkQuery.removeEventListener('change', listener)
}

/** Applies the `dark` class to <html>; index.html sets it before first paint to avoid a flash. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useStoredState<Theme>(storageKeys.theme, 'system')
  const systemDark = useSyncExternalStore(subscribeSystem, () => darkQuery.matches)
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
    document.documentElement.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
