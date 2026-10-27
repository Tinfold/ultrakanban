import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { notFound } from './errors.ts'
import { publish, wake } from './events.ts'

export const MIGRATIONS = [
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
  `
  -- Setup done in the app (one row): the board's GitHub token, the agent supervisor's last check-in with the agents'
  -- logins, and the latest login asked of it (see AgentHost).
  CREATE TABLE setup (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    github_token TEXT,
    agents_seen_at TEXT,
    agents_run_in TEXT,
    agents_github_login TEXT,
    agents_claude_account TEXT,
    agents_git_identity TEXT,
    login_kind TEXT,
    login_state TEXT,
    login_requested_at TEXT,
    login_url TEXT,
    login_user_code TEXT,
    login_code TEXT,
    login_message TEXT,
    login_updated_at TEXT
  );
  INSERT INTO setup (id) VALUES (1);
  `,
  `
  ALTER TABLE boards ADD COLUMN delete_merged_branches INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Disk space of each board's agent folder where the agents run, as the agent supervisor last measured it (see
  -- AgentDiskUsage). Keyed by the folder's name, a board id, which may be of a board deleted since.
  CREATE TABLE agent_disk_usage (
    board_id TEXT PRIMARY KEY,
    repo INTEGER NOT NULL,
    worktrees INTEGER NOT NULL,
    state INTEGER NOT NULL,
    measured_at TEXT NOT NULL
  );
  `,
  `
  -- The update: whether it merges origin (git pull --no-ff) instead of fast-forwarding, and the checkout's commit and
  -- local commits not on origin, as the supervisor reports them.
  ALTER TABLE app_update ADD COLUMN merge INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE app_update ADD COLUMN commit_sha TEXT;
  ALTER TABLE app_update ADD COLUMN ahead INTEGER;
  `,
  `
  -- When someone last asked the board's agent loops to clear their checkouts' build output (see BoardSummary).
  ALTER TABLE boards ADD COLUMN agent_cleanup_requested_at TEXT;
  `,
  `
  -- Every board's agents switched off at once from the header (see AgentServices), and the boards whose agent loop the
  -- agent supervisor last found running there, as a JSON array of board ids.
  ALTER TABLE setup ADD COLUMN agents_paused INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE setup ADD COLUMN agents_changed_at TEXT;
  ALTER TABLE setup ADD COLUMN agents_changed_by TEXT;
  ALTER TABLE setup ADD COLUMN agents_running TEXT;
  ALTER TABLE setup ADD COLUMN agents_reported_at TEXT;
  ALTER TABLE setup ADD COLUMN agents_handled_at TEXT;
  `,
  `
  -- Why claiming a ticket on the board last failed, and since when (see AgentServices). Cleared by a claim there that
  -- goes through or finds nothing to do, and when the supervisor reports the board's loop stopped.
  ALTER TABLE boards ADD COLUMN claim_error TEXT;
  ALTER TABLE boards ADD COLUMN claim_error_at TEXT;
  -- Whether the last switch on (agents_changed_at) asked for the running loops to be restarted too.
  ALTER TABLE setup ADD COLUMN agents_restart INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- What each agent run on a ticket did and how it ended (POST /tickets/:id/runs, see RunRecord), the newest
  -- RUN_RECORDS_KEPT per ticket. steps is a JSON array of { tool, summary, error }; omitted_after and omitted_count
  -- say how many steps of a long run were left out, and where.
  CREATE TABLE run_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    outcome TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER,
    turns INTEGER,
    cost_usd REAL,
    message TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    omitted_after INTEGER,
    omitted_count INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX run_records_ticket ON run_records(ticket_id, id);
  `,
  `
  -- The head commit of the ticket's pull request that pr_checks is about, and its checks that didn't pass (a JSON array
  -- of FailingCheck), as GitHub last reported. Their details are only read again when either changes.
  ALTER TABLE tickets ADD COLUMN pr_head_sha TEXT;
  ALTER TABLE tickets ADD COLUMN pr_failing_checks TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- Why the board's auto-merge isn't merging the ticket's pull request, as its latest round found (see AutoMergeWait):
  -- the reason for people, whether a merge attempt failed, and since when. NULL when it's ready or auto-merge is off.
  ALTER TABLE tickets ADD COLUMN auto_merge_wait TEXT;
  ALTER TABLE tickets ADD COLUMN auto_merge_failed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tickets ADD COLUMN auto_merge_since TEXT;
  `,
  `
  -- When someone asked the agent run working the ticket to stop (POST /tickets/:id/stop), and who. Cleared when the run
  -- ends, and when a new run starts after one that went quiet.
  ALTER TABLE tickets ADD COLUMN stop_requested_at TEXT;
  ALTER TABLE tickets ADD COLUMN stop_requested_by TEXT;
  `,
  `
  -- The usage reserve (see ClaudeUsageReserve): once a weekly limit of the Claude plan, or the current session, is used
  -- to this percent, agents claim no new tickets, leaving the rest to the user. Off when NULL.
  ALTER TABLE claude_usage ADD COLUMN week_reserve_percent INTEGER;
  ALTER TABLE claude_usage ADD COLUMN session_reserve_percent INTEGER;
  `,
  `
  -- How many more runs the board's agent can make at once that only fix merge conflicts (see BoardSummary). Its
  -- default (AGENT_DEFAULTS.conflictConcurrency) when NULL.
  ALTER TABLE boards ADD COLUMN agent_conflict_concurrency INTEGER;
  `,
  `
  -- Whether auto-merge goes ahead when the only failing checks failed because of billing (see BoardSummary).
  ALTER TABLE boards ADD COLUMN ignore_billing_failures INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The credits the Claude account can spend on usage besides its plan's limits (see ClaudeUsageCredit), as JSON.
  ALTER TABLE claude_usage ADD COLUMN credits TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- Whether agents go on claiming once a Claude usage limit is used up, on usage credits (see ClaudeUsageReserve).
  ALTER TABLE claude_usage ADD COLUMN usage_credits INTEGER NOT NULL DEFAULT 0;
  -- Credits now say their kind; the supervisor's next report fills them in again.
  UPDATE claude_usage SET credits = '[]';
  `,
  `
  -- Agents going on on their API key once Claude usage runs out (see AgentApiKey): whether they may, at most how many
  -- dollars a run and a calendar month may spend, and whether the agents last reported having a key.
  ALTER TABLE claude_usage ADD COLUMN api_key_fallback INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE claude_usage ADD COLUMN api_key_run_budget_usd REAL NOT NULL DEFAULT 5;
  ALTER TABLE claude_usage ADD COLUMN api_key_monthly_budget_usd REAL;
  ALTER TABLE setup ADD COLUMN agents_api_key INTEGER NOT NULL DEFAULT 0;
  -- Whether a run went on the agents' API key, so its cost was billed rather than estimated.
  ALTER TABLE token_usage ADD COLUMN api_key INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE run_records ADD COLUMN api_key INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The TypeSafe API key set on the Setup page (see docs/JEV.md); the API never sends it back.
  ALTER TABLE setup ADD COLUMN typesafe_api_key TEXT;
  `,
  `
  -- Routing tickets with Jev (see BoardSummary.jevEnabled and docs/JEV.md): whether it is on, the models it may pick (a
  -- JSON array, every alias when NULL), the confidence its pick needs (JEV_DEFAULTS when NULL), whether it may only pick
  -- a cheaper setting than the board's, and its mode ('dry-run' or 'on'; NULL until first switched on).
  ALTER TABLE boards ADD COLUMN jev_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE boards ADD COLUMN jev_models TEXT;
  ALTER TABLE boards ADD COLUMN jev_threshold REAL;
  ALTER TABLE boards ADD COLUMN jev_only_lower INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE boards ADD COLUMN jev_mode TEXT;
  `,
  `
  -- How a ticket was routed when it was last claimed (see RoutingSource and docs/JEV.md, item 8): the setting it is
  -- worked at and where that came from, and what each source picked, so sources can be compared by cost per finished
  -- ticket. Jev's pick is only there on boards that route with Jev, the history pick when the suggestion was built on
  -- enough similar tickets.
  CREATE TABLE ticket_routes (
    ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    confidence REAL,
    default_model TEXT NOT NULL,
    default_effort TEXT NOT NULL,
    history_model TEXT,
    history_effort TEXT,
    jev_model TEXT,
    jev_effort TEXT,
    jev_confidence REAL,
    created_at TEXT NOT NULL
  );
  -- Each run's routing, from its ticket's route when its usage is recorded (see RunRouting).
  ALTER TABLE token_usage ADD COLUMN routing_source TEXT;
  ALTER TABLE token_usage ADD COLUMN routing_confidence REAL;
  ALTER TABLE token_usage ADD COLUMN jev_model TEXT;
  ALTER TABLE token_usage ADD COLUMN jev_effort TEXT;
  ALTER TABLE token_usage ADD COLUMN jev_confidence REAL;
  `,
  `
  -- What Jev was told about the ticket when it picked (a hash of its content, see contentKey in server/jev-routing.ts),
  -- so a ticket whose content hasn't changed since isn't sent to Jev again.
  ALTER TABLE ticket_routes ADD COLUMN content_key TEXT;
  `,
  `
  -- How Jev's pick and the history suggestion combine (see BoardSummary.jevCombine; JEV_DEFAULTS when NULL).
  ALTER TABLE boards ADD COLUMN jev_combine TEXT;
  `,
  `
  -- The most turns a run of the board's agent may take (see BoardSummary.agentMaxTurns); NULL for no limit.
  ALTER TABLE boards ADD COLUMN agent_max_turns INTEGER;
  `,
  `
  -- Deleting a ticket keeps its runs (their ticket becomes NULL), so its spend stays in the board's totals. Dropping
  -- the old table cascades to token_usage_models (foreign keys are on), so the model split is set aside and put back.
  CREATE TEMP TABLE token_usage_models_kept AS SELECT * FROM token_usage_models;
  CREATE TABLE token_usage_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
    agent TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    cost_usd REAL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL,
    routing_source TEXT,
    routing_confidence REAL,
    jev_model TEXT,
    jev_effort TEXT,
    jev_confidence REAL,
    api_key INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO token_usage_new
    SELECT id, board_id, ticket_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, duration_ms, created_at, routing_source, routing_confidence, jev_model, jev_effort, jev_confidence,
      api_key
    FROM token_usage;
  DROP TABLE token_usage;
  ALTER TABLE token_usage_new RENAME TO token_usage;
  CREATE INDEX token_usage_ticket ON token_usage(ticket_id, id);
  CREATE INDEX token_usage_board ON token_usage(board_id, id);
  CREATE INDEX token_usage_created ON token_usage(created_at);
  INSERT INTO token_usage_models SELECT * FROM token_usage_models_kept;
  DROP TABLE token_usage_models_kept;
  `,
  `
  -- For the overview's queries over recent activity, by time and by actor (see overview.ts).
  CREATE INDEX activity_created_at ON activity(created_at);
  CREATE INDEX activity_actor ON activity(actor, id);
  `,
  `
  -- When the Claude usage limits were last read (see ClaudeUsage.limitsAt): a report with only an error keeps them.
  ALTER TABLE claude_usage ADD COLUMN limits_at TEXT;
  UPDATE claude_usage SET limits_at = reported_at;
  `,
  `
  -- Tokens the run working the ticket has used so far, as its heartbeats say, and those a run record's run used.
  ALTER TABLE tickets ADD COLUMN run_tokens INTEGER;
  ALTER TABLE run_records ADD COLUMN tokens INTEGER;
  `,
  `
  -- Model and effort for the board agent's runs that only fix merge conflicts, and those that only fix failing CI (see
  -- BoardSummary). AGENT_DEFAULTS' conflictModel, conflictEffort, ciModel and ciEffort when NULL.
  ALTER TABLE boards ADD COLUMN agent_conflict_model TEXT;
  ALTER TABLE boards ADD COLUMN agent_conflict_effort TEXT;
  ALTER TABLE boards ADD COLUMN agent_ci_model TEXT;
  ALTER TABLE boards ADD COLUMN agent_ci_effort TEXT;
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
let wokenBoards: Set<string> | null = null

/**
 * Runs `fn` inside an IMMEDIATE transaction (write lock acquired up front), so every
 * read-check-write sequence inside it is atomic. Change events for boards touched via
 * `touchBoard`, and wake events for boards whose agent `wakeAgent` asked for, are published
 * only after a successful commit.
 */
export function transaction<T>(fn: () => T): T {
  if (changedBoards) throw new Error('Nested transactions are not supported')
  changedBoards = new Set()
  wokenBoards = new Set()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    const changed = changedBoards
    const woken = wokenBoards
    changedBoards = wokenBoards = null
    for (const boardId of changed) publish({ boardId })
    for (const boardId of woken) wake({ boardId })
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    changedBoards = wokenBoards = null
    throw error
  }
}

/** Marks a board as changed (bumping `updated_at`); throws 404 if it does not exist. */
export function touchBoard(boardId: string) {
  const { changes } = sql.run('UPDATE boards SET updated_at = ? WHERE id = ?', now(), boardId)
  if (!changes) throw notFound('Board', boardId)
  changedBoards?.add(boardId)
}

/**
 * Wakes the board's idle agent loops up once the transaction commits (see `wake`), so they look at the board now
 * rather than after their idle wait, e.g. for a person's feedback on a ticket the agent holds. Once per board and
 * transaction, and not at all if it rolls back.
 */
export function wakeAgent(boardId: string) {
  if (!wokenBoards) throw new Error('wakeAgent needs a transaction')
  wokenBoards.add(boardId)
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
