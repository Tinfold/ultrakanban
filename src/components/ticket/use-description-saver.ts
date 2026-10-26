import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Ticket } from '@shared/domain'
import type { BoardActions } from '@/hooks/use-board-actions'
import { useDebouncedCallback } from '@/hooks/use-debounced-callback'

/** Retries after conflicts that only changed other fields (priority, tags…), before giving up. */
const MAX_RETRIES = 3

const copyText = async (text: string) => {
  await navigator.clipboard.writeText(text)
  toast.success('Your text is copied')
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
            action: { label: 'Copy my text', onClick: () => void copyText(kept) },
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

  /** The editor shows the ticket's description: edits from here on are based on its current version. */
  const onSync = useCallback((markdown: string) => {
    if (unsaved.current !== null || saving.current || conflicted.current) return
    base.current = { version: latest.current.version, description: markdown }
  }, [])

  const resolve = (keepMine: boolean) => {
    conflicted.current = false
    setConflict(null)
    base.current = { version: latest.current.version, description: latest.current.description }
    if (keepMine) {
      void save()
    } else {
      if (unsaved.current !== null) void copyText(unsaved.current)
      unsaved.current = null
      setEditorKey((key) => key + 1)
    }
  }

  return {
    onChange,
    onBlur: debounced.flush,
    onSync,
    editorKey,
    /** The person's text that couldn't be saved because the description changed meanwhile. */
    conflict,
    copyConflict: () => conflict !== null && void copyText(conflict),
    /** Copies their text and shows the latest description instead. */
    loadLatest: () => resolve(false),
    /** Saves their text over the latest description. */
    saveMine: () => resolve(true),
  }
}
