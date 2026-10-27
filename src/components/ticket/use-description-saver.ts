import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Ticket } from '@shared/domain'
import type { BoardActions } from '@/hooks/use-board-actions'
import { useDebouncedCallback } from '@/hooks/use-debounced-callback'
import { copyText } from '@/lib/clipboard'

/** Retries after conflicts that only changed other fields (priority, tags…), before giving up. */
const MAX_RETRIES = 3

/** Copies the person's text, saying whether that worked. */
const copyMine = async (text: string) => {
  try {
    await copyText(text)
  } catch {
    toast.error('Couldn’t copy your text to the clipboard')
    return false
  }
  toast.success('Your text is copied')
  return true
}

/**
 * Saves a ticket's description as the person types, with `ifVersion`, so it can't silently overwrite changes made
 * meanwhile (an agent ticking checklist steps, someone in another tab). On such a conflict it stops saving and keeps the
 * person's text in `conflict`, so they can copy it, load the latest description, or save theirs anyway.
 */
export function useDescriptionSaver(ticket: Ticket, actions: BoardActions) {
  const latest = useRef(ticket)
  useEffect(() => {
    latest.current = ticket
  })
  // The version and description the person's text is based on.
  const base = useRef({ version: ticket.version, description: ticket.description })
  // Their text that isn't saved yet.
  const unsaved = useRef<string | null>(null)
  const saving = useRef(false)
  const conflicted = useRef(false)
  const [conflict, setConflict] = useState<string | null>(null)
  // Their text couldn't be copied, so loading the latest description would lose it.
  const [copyFailed, setCopyFailed] = useState(false)
  // Bumped to make the editor show the ticket's description again.
  const [editorKey, setEditorKey] = useState(0)

  const save = useCallback(async () => {
    if (saving.current) return
    saving.current = true
    try {
      // Goes on while they type more during a save.
      for (let text = unsaved.current; text !== null && !conflicted.current; text = unsaved.current) {
        let result = await actions.saveDescription(ticket.id, text, base.current.version)
        // Only other fields changed meanwhile, so the person's text still holds.
        for (let retry = 0; retry < MAX_RETRIES && result && 'conflict' in result; retry++) {
          if (result.conflict.description !== base.current.description) break
          base.current = { version: result.conflict.version, description: result.conflict.description }
          result = await actions.saveDescription(ticket.id, text, base.current.version)
        }
        // Another error, already shown: the next edit tries again.
        if (!result) return
        if ('conflict' in result) {
          conflicted.current = true
          setConflict(unsaved.current)
          const kept = unsaved.current ?? text
          toast.error('Someone changed the description while you were editing it, so your edit wasn’t saved', {
            action: { label: 'Copy my text', onClick: () => void copyMine(kept) },
            duration: 10_000,
          })
          return
        }
        base.current = { version: result.ticket.version, description: result.ticket.description }
        if (unsaved.current === text) unsaved.current = null
      }
    } finally {
      saving.current = false
    }
  }, [actions, ticket.id])

  const debounced = useDebouncedCallback(() => void save(), 800)

  const onChange = useCallback(
    (markdown: string) => {
      unsaved.current = markdown
      if (conflicted.current) setConflict(markdown)
      else debounced.schedule()
    },
    [debounced],
  )

  /**
   * The person has text that isn't saved yet: being typed or saved, or kept after a conflict. The editor keeps showing
   * it rather than the ticket's description meanwhile, which a failed save rolls back and a conflict replaces.
   */
  const hasUnsavedEdits = useCallback(() => unsaved.current !== null || saving.current || conflicted.current, [])

  /** The editor shows the ticket's description: edits from here on are based on its current version. */
  const onSync = useCallback(
    (markdown: string) => {
      if (hasUnsavedEdits()) return
      base.current = { version: latest.current.version, description: markdown }
    },
    [hasUnsavedEdits],
  )

  const copy = async (text: string) => {
    const copied = await copyMine(text)
    if (!copied) setCopyFailed(true)
    return copied
  }

  const endConflict = () => {
    conflicted.current = false
    setConflict(null)
    setCopyFailed(false)
    base.current = { version: latest.current.version, description: latest.current.description }
  }

  /**
   * Copies their text, then shows the latest description instead. If their text can't be copied it stays, and only a
   * second try (see `copyFailed`) drops it.
   */
  const loadLatest = async () => {
    const text = unsaved.current
    if (text !== null && !copyFailed && !(await copy(text))) return
    // Resolved meanwhile (a second click, or saving theirs).
    if (!conflicted.current) return
    endConflict()
    unsaved.current = null
    setEditorKey((key) => key + 1)
  }

  return {
    onChange,
    onBlur: debounced.flush,
    onSync,
    hasUnsavedEdits,
    editorKey,
    /** The person's text that couldn't be saved because the description changed meanwhile. */
    conflict,
    /** Their text couldn't be copied, so `loadLatest` would drop it. */
    copyFailed,
    copyConflict: () => conflict !== null && void copy(conflict),
    /** Copies their text and shows the latest description instead; keeps their text if it can't be copied. */
    loadLatest: () => void loadLatest(),
    /** Saves their text over the latest description. */
    saveMine: () => {
      endConflict()
      void save()
    },
  }
}
