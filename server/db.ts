import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { notFound } from './errors.ts'
import { publish } from './events.ts'

const MIGRATIONS = [
  `
  CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE columns (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    wip_limit INTEGER,
    position INTEGER NOT NULL
  );
  CREATE INDEX columns_board ON columns(board_id, position);
  CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    color TEXT NOT NULL,
    UNIQUE (board_id, name)
  );
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    assignee TEXT,
    due_date TEXT,
    position INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (board_id, number)
  );
  CREATE INDEX tickets_column ON tickets(column_id, position);
  CREATE TABLE ticket_tags (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, tag_id)
  );
  CREATE INDEX ticket_tags_tag ON ticket_tags(tag_id);
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX activity_ticket ON activity(ticket_id, id);
  `,
  `
  ALTER TABLE boards ADD COLUMN review_column_id TEXT REFERENCES columns(id) ON DELETE SET NULL;
  ALTER TABLE boards ADD COLUMN done_column_id TEXT REFERENCES columns(id) ON DELETE SET NULL;
  ALTER TABLE tickets ADD COLUMN pr_url TEXT;
  ALTER TABLE tickets ADD COLUMN pr_state TEXT NOT NULL DEFAULT 'unknown';
  ALTER TABLE tickets ADD COLUMN pr_title TEXT;
  ALTER TABLE tickets ADD COLUMN pr_checked_at TEXT;
  CREATE INDEX tickets_pull_request ON tickets(pr_state) WHERE pr_url IS NOT NULL;
  -- Existing boards adopt the pull request workflow for columns conventionally named "Review" and "Done".
  UPDATE boards SET
    review_column_id = (SELECT id FROM columns WHERE board_id = boards.id AND name = 'review' COLLATE NOCASE ORDER BY position LIMIT 1),
    done_column_id = (SELECT id FROM columns WHERE board_id = boards.id AND name = 'done' COLLATE NOCASE ORDER BY position LIMIT 1);
  `,
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX attachments_ticket ON attachments(ticket_id, created_at);
  `,
  `
  ALTER TABLE boards ADD COLUMN github_repo TEXT;
  ALTER TABLE boards ADD COLUMN agent_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE boards ADD COLUMN agent_name TEXT;
  `,
  `
  ALTER TABLE boards ADD COLUMN agent_model TEXT;
  ALTER TABLE boards ADD COLUMN agent_effort TEXT;
  `,
]

export const databasePath = process.env.ULTRAKANBAN_DB ?? 'data/ultrakanban.db'
const path = databasePath
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

const db = new DatabaseSync(path)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

function migrate() {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  MIGRATIONS.slice(current).forEach((sql, i) => {
    transaction(() => {
      db.exec(sql)
      db.exec(`PRAGMA user_version = ${current + i + 1}`)
    })
  })
}

const statements = new Map<string, StatementSync>()

function statement(sql: string) {
  let stmt = statements.get(sql)
  if (!stmt) {
    stmt = db.prepare(sql)
    statements.set(sql, stmt)
  }
  return stmt
}

export const sql = {
  get: <T>(query: string, ...params: SQLInputValue[]) => statement(query).get(...params) as T | undefined,
  all: <T>(query: string, ...params: SQLInputValue[]) => statement(query).all(...params) as T[],
  run: (query: string, ...params: SQLInputValue[]) => statement(query).run(...params),
}

let changedBoards: Set<string> | null = null

/**
 * Runs `fn` inside an IMMEDIATE transaction (write lock acquired up front), so every
 * read-check-write sequence inside it is atomic. Change events for boards touched via
 * `touchBoard` are published only after a successful commit.
 */
export function transaction<T>(fn: () => T): T {
  if (changedBoards) throw new Error('Nested transactions are not supported')
  changedBoards = new Set()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    const changed = changedBoards
    changedBoards = null
    for (const boardId of changed) publish({ boardId })
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    changedBoards = null
    throw error
  }
}

/** Marks a board as changed (bumping `updated_at`); throws 404 if it does not exist. */
export function touchBoard(boardId: string) {
  const { changes } = sql.run('UPDATE boards SET updated_at = ? WHERE id = ?', now(), boardId)
  if (!changes) throw notFound('Board', boardId)
  changedBoards?.add(boardId)
}

type Table = 'boards' | 'columns' | 'tags' | 'tickets'

/** Updates the given columns of a row, ignoring `undefined` values. */
export function updateRow(table: Table, id: string, fields: Record<string, SQLInputValue | undefined>) {
  const entries = Object.entries(fields).filter((entry): entry is [string, SQLInputValue] => entry[1] !== undefined)
  if (!entries.length) return
  const assignments = entries.map(([column]) => `${column} = ?`).join(', ')
  sql.run(`UPDATE ${table} SET ${assignments} WHERE id = ?`, ...entries.map(([, value]) => value), id)
}

/** Closes the database, checkpointing the write-ahead log. */
export const closeDatabase = () => db.close()

export const newId = () => randomBytes(8).toString('base64url')

export const now = () => new Date().toISOString()

/** Rewrites `position` so rows follow the order of `ids`. */
export function reorder(table: Extract<Table, 'columns' | 'tickets'>, ids: string[]) {
  ids.forEach((id, position) => sql.run(`UPDATE ${table} SET position = ? WHERE id = ?`, position, id))
}

migrate()
