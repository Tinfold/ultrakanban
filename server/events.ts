import type { BoardChangeEvent } from '../shared/domain.ts'

type Listener = (event: BoardChangeEvent) => void

const listeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publish(event: BoardChangeEvent) {
  for (const listener of listeners) listener(event)
}
