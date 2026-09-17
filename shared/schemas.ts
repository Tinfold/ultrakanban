import { z } from 'zod'
import { COLORS, parsePullRequestUrl, PRIORITIES, PULL_REQUEST_STATES } from './domain.ts'

const name = z.string().trim().min(1).max(200)
const color = z.enum(COLORS)
const priority = z.enum(PRIORITIES)
const position = z.int().min(0)
const version = z.int().min(1)
const wipLimit = z.int().min(1).nullable()
const isoDate = z.iso.date().nullable()
/** Either an entity id or its (case-insensitive) name. */
const ref = z.string().trim().min(1)
const pullRequestUrl = z
  .string()
  .trim()
  .refine(
    (url) => parsePullRequestUrl(url),
    'Must be a GitHub pull request URL, e.g. https://github.com/owner/repo/pull/123',
  )
/** Skips the merged-pull-request requirement of the board's done column. Meant for humans, not agents. */
const force = z.boolean().optional()

export const createBoardSchema = z.object({
  name,
  description: z.string().max(5000).optional(),
  columns: z.array(name).max(50).optional(),
  reviewColumn: ref.optional(),
  doneColumn: ref.optional(),
})

export const updateBoardSchema = z.object({
  name: name.optional(),
  description: z.string().max(5000).optional(),
  reviewColumn: ref.nullable().optional(),
  doneColumn: ref.nullable().optional(),
})

export const createColumnSchema = z.object({
  name,
  color: color.optional(),
  wipLimit: wipLimit.optional(),
  position: position.optional(),
})

export const updateColumnSchema = z.object({
  name: name.optional(),
  color: color.optional(),
  wipLimit: wipLimit.optional(),
})

export const moveColumnSchema = z.object({ position })

export const deleteColumnSchema = z.object({ moveTicketsTo: ref.optional() })

export const createTagSchema = z.object({ name, color: color.optional() })

export const updateTagSchema = z.object({ name: name.optional(), color: color.optional() })

export const createTicketSchema = z.object({
  title: name,
  description: z.string().max(100_000).optional(),
  column: ref.optional(),
  priority: priority.optional(),
  tags: z.array(ref).max(50).optional(),
  assignee: name.nullable().optional(),
  dueDate: isoDate.optional(),
  pullRequest: pullRequestUrl.nullable().optional(),
  position: position.optional(),
  force,
})

export const updateTicketSchema = z.object({
  title: name.optional(),
  description: z.string().max(100_000).optional(),
  priority: priority.optional(),
  tags: z.array(ref).max(50).optional(),
  assignee: name.nullable().optional(),
  dueDate: isoDate.optional(),
  pullRequest: pullRequestUrl.nullable().optional(),
  ifVersion: version.optional(),
})

export const moveTicketSchema = z.object({
  column: ref,
  position: position.optional(),
  ifVersion: version.optional(),
  force,
})

export const submitForReviewSchema = z.object({
  agent: name,
  pullRequest: pullRequestUrl,
  /** Markdown summary posted as a comment, e.g. what changed and how it was verified. */
  comment: z.string().trim().min(1).max(20_000).optional(),
  ifVersion: version.optional(),
})

export const claimTicketSchema = z.object({
  agent: name,
  moveTo: ref.optional(),
  ifVersion: version.optional(),
})

export const releaseTicketSchema = z.object({
  agent: name,
  moveTo: ref.optional(),
  force: z.boolean().optional(),
})

export const claimNextSchema = z.object({
  agent: name,
  column: ref,
  tags: z.array(ref).optional(),
  moveTo: ref.optional(),
})

export const commentSchema = z.object({ body: z.string().trim().min(1).max(20_000) })

export const listTicketsQuerySchema = z.object({
  column: ref.optional(),
  assignee: name.optional(),
  unassigned: z.stringbool().optional(),
  tag: z.array(ref).optional(),
  priority: z.array(priority).optional(),
  q: z.string().trim().min(1).optional(),
})

export const BOARD_EXPORT_FORMAT = 'ultrakanban/board@1'

export const boardExportSchema = z.object({
  format: z.literal(BOARD_EXPORT_FORMAT),
  board: z.object({
    name,
    description: z.string().max(5000).default(''),
    reviewColumn: name.nullable().default(null),
    doneColumn: name.nullable().default(null),
  }),
  columns: z.array(z.object({ name, color: color.default('gray'), wipLimit: wipLimit.default(null) })),
  tags: z.array(z.object({ name, color: color.default('gray') })),
  tickets: z.array(
    z.object({
      title: name,
      description: z.string().default(''),
      column: name,
      priority: priority.default('none'),
      tags: z.array(name).default([]),
      assignee: name.nullable().default(null),
      dueDate: isoDate.default(null),
      pullRequest: z
        .object({
          url: pullRequestUrl,
          state: z.enum(PULL_REQUEST_STATES).default('unknown'),
          title: z.string().nullable().default(null),
        })
        .nullable()
        .default(null),
      comments: z.array(z.object({ actor: name, body: z.string().min(1), createdAt: z.iso.datetime() })).default([]),
    }),
  ),
})

export type CreateBoardInput = z.input<typeof createBoardSchema>
export type UpdateBoardInput = z.input<typeof updateBoardSchema>
export type CreateColumnInput = z.input<typeof createColumnSchema>
export type UpdateColumnInput = z.input<typeof updateColumnSchema>
export type CreateTagInput = z.input<typeof createTagSchema>
export type UpdateTagInput = z.input<typeof updateTagSchema>
export type CreateTicketInput = z.input<typeof createTicketSchema>
export type UpdateTicketInput = z.input<typeof updateTicketSchema>
export type MoveTicketInput = z.input<typeof moveTicketSchema>
export type ClaimTicketInput = z.input<typeof claimTicketSchema>
export type ReleaseTicketInput = z.input<typeof releaseTicketSchema>
export type SubmitForReviewInput = z.input<typeof submitForReviewSchema>
export type ClaimNextInput = z.input<typeof claimNextSchema>
export type ListTicketsQuery = z.output<typeof listTicketsQuerySchema>
export type BoardExport = z.output<typeof boardExportSchema>
