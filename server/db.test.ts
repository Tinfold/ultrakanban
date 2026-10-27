import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { MIGRATIONS } from './db.ts'

/**
 * The migrations on main when this was last updated: a database on main is at `count` (its user_version), and
 * `migrate()` only runs the ones after it, so these must never change or move. Update both when main has more.
 */
const MAIN = { count: 43, sha256: '6a1f3c8f9d231025332a15bd3c58d9a55a95b6928e22280b5cfe6f9aede77b3a' }

const hash = (migrations: string[]) => createHash('sha256').update(migrations.join('\0')).digest('hex')

test("keeps main's migrations first and unchanged, so a database on main migrates", () => {
  assert.equal(hash(MIGRATIONS.slice(0, MAIN.count)), MAIN.sha256, "add new migrations after main's, at the end")
})
