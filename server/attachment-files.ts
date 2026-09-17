import { createReadStream } from 'node:fs'
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import type { AttachmentType } from '../shared/domain.ts'

export type AttachmentFiles = ReturnType<typeof createAttachmentFiles>

const matches = (bytes: Uint8Array, signature: number[] | string, offset = 0) =>
  [...signature].every(
    (expected, index) => bytes[offset + index] === (typeof expected === 'string' ? expected.charCodeAt(0) : expected),
  )

/** Identifies a supported media type from the file contents; the type a client declares isn't trusted. */
export function detectAttachmentType(bytes: Uint8Array): AttachmentType | null {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (matches(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (matches(bytes, 'GIF87a') || matches(bytes, 'GIF89a')) return 'image/gif'
  if (matches(bytes, 'RIFF') && matches(bytes, 'WEBP', 8)) return 'image/webp'
  if (matches(bytes, 'ftyp', 4)) return 'video/mp4'
  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  return null
}

const EXTENSIONS: Record<AttachmentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** A display-safe file name: no directories or control characters, with a fallback for unnamed uploads. */
export function attachmentFilename(name: string, type: AttachmentType) {
  const printable = [...basename(name.replaceAll('\\', '/'))].filter((char) => {
    const code = char.charCodeAt(0)
    return code > 0x1f && code !== 0x7f
  })
  const cleaned = printable.join('').trim().slice(0, 200)
  return cleaned || `attachment.${EXTENSIONS[type]}`
}

/** Attachment contents on disk, one file per attachment id. Metadata lives in the database. */
export function createAttachmentFiles(directory: string) {
  const pathOf = (id: string) => join(directory, id)

  return {
    async write(id: string, bytes: Uint8Array) {
      await mkdir(directory, { recursive: true })
      await writeFile(pathOf(id), bytes)
    },

    /** The file's contents, or `null` if it is missing on disk. */
    async open(id: string) {
      const path = pathOf(id)
      const exists = await access(path).then(
        () => true,
        () => false,
      )
      return exists ? (Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>) : null
    },

    remove: (id: string) => rm(pathOf(id), { force: true }),

    /** Deletes files whose attachment no longer exists, e.g. after deleting tickets, columns or boards. */
    async sweep(existingIds: Set<string>) {
      const files = await readdir(directory).catch(() => [])
      await Promise.all(files.filter((id) => !existingIds.has(id)).map((id) => rm(pathOf(id), { force: true })))
    },
  }
}
