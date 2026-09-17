import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { parseStored, readRaw, readStored, subscribeStorage, writeStored } from '@/lib/storage'

/** State persisted in localStorage and shared by every component using the same key. */
export function useStoredState<T>(key: string, fallback: T) {
  const [initialFallback] = useState(fallback)
  const raw = useSyncExternalStore(subscribeStorage, () => readRaw(key))
  const value = useMemo(() => parseStored(raw, initialFallback), [raw, initialFallback])

  const setValue = useCallback(
    (next: T | ((previous: T) => T)) => {
      const previous = readStored(key, initialFallback)
      writeStored(key, typeof next === 'function' ? (next as (previous: T) => T)(previous) : next)
    },
    [key, initialFallback],
  )

  return [value, setValue] as const
}
