import { useCallback, useEffect, useRef } from 'react'

/** Debounces `callback`; pending calls can be flushed and are flushed automatically on unmount. */
export function useDebouncedCallback<A extends unknown[]>(callback: (...args: A) => void, delay: number) {
  const callbackRef = useRef(callback)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pendingRef = useRef<A>(undefined)

  useEffect(() => {
    callbackRef.current = callback
  })

  const flush = useCallback(() => {
    clearTimeout(timerRef.current)
    const args = pendingRef.current
    if (!args) return
    pendingRef.current = undefined
    callbackRef.current(...args)
  }, [])

  const schedule = useCallback(
    (...args: A) => {
      pendingRef.current = args
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, delay)
    },
    [flush, delay],
  )

  useEffect(() => flush, [flush])
  return { schedule, flush }
}
