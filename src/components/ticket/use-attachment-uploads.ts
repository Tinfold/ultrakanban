import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { ATTACHMENT_TYPES } from '@shared/domain'
import { useBoardContext } from '../board/board-context'

const isSupported = (file: File) => (ATTACHMENT_TYPES as readonly string[]).includes(file.type)

/** Upload state for one ticket, shared by the attachments section and the dialog's paste handler. */
export function useAttachmentUploads(ticketId: string) {
  const { actions } = useBoardContext()
  const [uploading, setUploading] = useState(0)

  const upload = useCallback(
    async (files: File[]) => {
      const supported = files.filter(isSupported)
      if (supported.length < files.length) toast.error('Only PNG, JPEG, GIF, WebP, MP4 and WebM files can be attached')
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
