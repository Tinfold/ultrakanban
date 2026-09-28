/**
 * Deletes that wait a few seconds before they are sent, so they can still be undone. The ticket is hidden from the
 * board meanwhile. Kept outside React so a delete still goes through after its board is closed.
 */
export class PendingDeletes {
  private readonly pending = new Map<string, { commit: () => void; timer: ReturnType<typeof setTimeout> }>()

  private readonly delay: number

  constructor(delay: number) {
    this.delay = delay
  }

  /** Runs `commit` after the delay, unless the delete is undone or sent earlier. */
  schedule(id: string, commit: () => void) {
    this.cancel(id)
    const timer = setTimeout(() => this.commit(id), this.delay)
    this.pending.set(id, { commit, timer })
  }

  /** Sends the delete now. Returns false if it was already sent or undone. */
  commit(id: string) {
    const entry = this.take(id)
    entry?.commit()
    return !!entry
  }

  /** Undoes the delete. Returns false if it was already sent. */
  cancel(id: string) {
    return !!this.take(id)
  }

  /** Sends every waiting delete, e.g. when the page is closed. */
  flush() {
    for (const id of [...this.pending.keys()]) this.commit(id)
  }

  has(id: string) {
    return this.pending.has(id)
  }

  private take(id: string) {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    clearTimeout(entry.timer)
    this.pending.delete(id)
    return entry
  }
}

/** How long the undo toast stays up. Closing it sends the delete. */
export const UNDO_DELAY = 6000

/**
 * The toast sends the delete when it closes, but it pauses while hovered; the timer here only makes sure the delete
 * is sent if the toast never closes.
 */
export const pendingDeletes = new PendingDeletes(UNDO_DELAY * 5)
