import { Hono } from 'hono'
import { updateTagSchema } from '../../shared/schemas.ts'
import { transaction } from '../db.ts'
import { readJson } from '../http.ts'
import { deleteTag, updateTag } from '../store/tags.ts'

export const tagRoutes = new Hono()
  .patch('/:tagId', async (c) => {
    const input = await readJson(c, updateTagSchema)
    return c.json(transaction(() => updateTag(c.req.param('tagId'), input)))
  })
  .delete('/:tagId', (c) => {
    transaction(() => deleteTag(c.req.param('tagId')))
    return c.body(null, 204)
  })
