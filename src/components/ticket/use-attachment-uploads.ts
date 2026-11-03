import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { formatAttachmentLimit, maxAttachmentBytes } from '@shared/domain'
import { readActor } from '@/lib/actor'
import { useBoardContext } from '../board/board-context'

/** Upload state for one ticket, shared by the attachments section and the dialog's paste handler. */
export function useAttachmentUploads(ticketId: string) {
  const { actions } = useBoardContext()
  const [uploading, setUploading] = useState(0)

  const upload = useCallback(
    async (files: File[]) => {
      // The server holds uploads to the same limit, by the name they're sent under.
      const maxBytes = maxAttachmentBytes(readActor())
      const supported = files.filter((file) => file.size <= maxBytes)
      if (supported.length < files.length) toast.error(`Attachments can be at most ${formatAttachmentLimit(maxBytes)}`)
      if (!supported.length) return
      setUploading((count) => count + supported.length)
      await actions.uploadAttachments(ticketId, supported)
      setUploading((count) => count - supported.length)
    },
    [actions, ticketId],
  )

  return { uploading, upload }
}

export type AttachmentUploads = ReturnType<typeof useAttachmentUploads>
