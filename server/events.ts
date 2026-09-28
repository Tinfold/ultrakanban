import type { BoardChangeEvent } from '../shared/domain.ts'

type Listener = (event: BoardChangeEvent) => void

const listeners = new Set<Listener>()
const wakeListeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publish(event: BoardChangeEvent) {
  for (const listener of listeners) listener(event)
}

/** Listens for requests to wake a board's agent up (see `wake`). */
export function subscribeWake(listener: Listener): () => void {
  wakeListeners.add(listener)
  return () => wakeListeners.delete(listener)
}

/** Asks a board's idle agent loops to look for work now rather than after their idle wait. */
export function wake(event: BoardChangeEvent) {
  for (const listener of wakeListeners) listener(event)
}
