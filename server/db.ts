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
  `
  ALTER TABLE tickets ADD COLUMN agent_effort TEXT;
  `,
  `
  -- Agents cleared from the overview, with the newest activity entry at the time: they reappear once they act again.
  CREATE TABLE hidden_agents (
    name TEXT PRIMARY KEY,
    last_activity_id INTEGER NOT NULL
  );
  `,
  `
  -- Tokens each agent run used on a ticket, as reported by the agent (scripts/agent-loop.sh reports its runs).
  CREATE TABLE token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    cost_usd REAL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX token_usage_ticket ON token_usage(ticket_id, id);
  CREATE INDEX token_usage_created ON token_usage(created_at);
  `,
  `
  -- Agents can report runs that weren't on a ticket (POST /boards/:id/usage), so usage belongs to a board and
  -- optionally to one of its tickets.
  CREATE TABLE token_usage_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    cost_usd REAL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );
  INSERT INTO token_usage_new
    SELECT u.id, t.board_id, u.ticket_id, u.agent, u.input_tokens, u.output_tokens, u.cache_read_tokens,
      u.cache_write_tokens, u.cost_usd, u.duration_ms, u.created_at
    FROM token_usage u JOIN tickets t ON t.id = u.ticket_id;
  DROP TABLE token_usage;
  ALTER TABLE token_usage_new RENAME TO token_usage;
  CREATE INDEX token_usage_ticket ON token_usage(ticket_id, id);
  CREATE INDEX token_usage_board ON token_usage(board_id, id);
  CREATE INDEX token_usage_created ON token_usage(created_at);
  `,
  `
  -- How many runs the board's agent works at once, each in its own git worktree (1 when null).
  ALTER TABLE boards ADD COLUMN agent_concurrency INTEGER;
  `,
  `
  -- A run's tokens split by the models it called, when the agent reports that.
  CREATE TABLE token_usage_models (
    usage_id INTEGER NOT NULL REFERENCES token_usage(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    cost_usd REAL,
    PRIMARY KEY (usage_id, model)
  );
  `,
  `
  -- Whether the board's agent also takes tickets from the backlog column once the todo column is empty.
  ALTER TABLE boards ADD COLUMN agent_backlog INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE tickets ADD COLUMN agent_model TEXT;
  -- Whether the board's agent runs load every skill, not only the ultrakanban skill (see scripts/agent-loop.sh).
  ALTER TABLE boards ADD COLUMN agent_all_skills INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- When an agent last said it is working on the ticket (POST /tickets/:id/heartbeat); not a change to the ticket.
  ALTER TABLE tickets ADD COLUMN agent_seen_at TEXT;
  `,
  `
  -- Whether the ticket's pull request has merge conflicts with its base branch, as GitHub last reported.
  ALTER TABLE tickets ADD COLUMN pr_conflicts INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Whether the server merges the review column's pull requests once they are ready (see server/merge-queue.ts).
  ALTER TABLE boards ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Days after which tickets in the done column are archived: left out of GET /boards/:id. Never when NULL.
  ALTER TABLE boards ADD COLUMN archive_done_days INTEGER;
  -- When the ticket entered its current column.
  ALTER TABLE tickets ADD COLUMN moved_at TEXT;
  UPDATE tickets SET moved_at = coalesce(
    (SELECT max(created_at) FROM activity WHERE ticket_id = tickets.id AND type IN ('created', 'moved')),
    created_at
  );
  `,
  `
  -- The agent run working the ticket (see POST /tickets/:id/heartbeat): when its first heartbeat came, and what it
  -- last said it is doing. Cleared when the run ends; a run without a heartbeat for AGENT_IDLE_MINUTES is over too.
  ALTER TABLE tickets ADD COLUMN run_started_at TEXT;
  ALTER TABLE tickets ADD COLUMN run_step TEXT;
  `,
  `
  -- Combined status of the pull request's checks ('pending', 'passing', 'failing'), as GitHub last reported;
  -- NULL when it has none, or isn't open or draft.
  ALTER TABLE tickets ADD COLUMN pr_checks TEXT;
  `,
  `
  -- The ticket this one is a sub-ticket of (POST /tickets/:id/children); the parent waits for its sub-tickets.
  ALTER TABLE tickets ADD COLUMN parent_id TEXT REFERENCES tickets(id) ON DELETE SET NULL;
  CREATE INDEX tickets_parent ON tickets(parent_id);
  `,
  `
  -- Where the board sends a message when a ticket needs a person (see server/notifications.ts). None when NULL.
  ALTER TABLE boards ADD COLUMN notify_url TEXT;
  -- Notifications sent, so none is sent twice: one per ticket and key (e.g. the comment or commit it is about).
  CREATE TABLE notifications (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (ticket_id, key)
  );
  `,
  `
  -- The size ('S', 'M', 'L') the ticket's agent estimated it at in its latest plan (POST /tickets/:id/plan), and
  -- whether that plan waits for a person's approval ('pending') or has it ('approved'); NULL when it needs none.
  ALTER TABLE tickets ADD COLUMN estimate TEXT;
  ALTER TABLE tickets ADD COLUMN approval TEXT;
  -- Smallest estimate at which the board's agent waits for approval of its plan; NULL never waits.
  ALTER TABLE boards ADD COLUMN approval_size TEXT;
  `,
  `
  -- Whether the board's agent runs Claude in a Docker container rather than directly on the machine, and a ticket's
  -- own choice (NULL: the board's).
  ALTER TABLE boards ADD COLUMN agent_docker INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tickets ADD COLUMN agent_docker INTEGER;
  `,
  `
  -- Epics group tickets of a board into a larger piece of work; they are done once all their tickets are.
  CREATE TABLE epics (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title TEXT NOT NULL COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (board_id, title)
  );
  ALTER TABLE tickets ADD COLUMN epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL;
  CREATE INDEX tickets_epic ON tickets(epic_id);
  `,
  `
  -- Updating ultrakanban itself (one row): asked for in the app, done on the host by the agent supervisor.
  CREATE TABLE app_update (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL DEFAULT 'idle',
    requested_at TEXT,
    requested_by TEXT,
    finished_at TEXT,
    message TEXT,
    updater_seen_at TEXT,
    version TEXT,
    behind INTEGER
  );
  INSERT INTO app_update (id) VALUES (1);
  `,
  `
  -- How much of the Claude plan's usage limits is used (one row), as the agent supervisor last reported it.
  CREATE TABLE claude_usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    reported_at TEXT,
    plan TEXT,
    limits TEXT NOT NULL DEFAULT '[]',
    error TEXT
  );
  INSERT INTO claude_usage (id) VALUES (1);
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

type Table = 'boards' | 'columns' | 'tags' | 'epics' | 'tickets'

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
