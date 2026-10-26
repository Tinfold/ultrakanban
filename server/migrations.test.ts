import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { MIGRATIONS } from './db.ts'

describe('migrations', () => {
  test('keep token usage, and its split by model, when token_usage is rebuilt to outlive its tickets', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    const setNull = MIGRATIONS.findIndex((sql) => sql.includes('token_usage_models_kept'))
    assert.ok(setNull > 0)
    for (const sql of MIGRATIONS.slice(0, setNull)) db.exec(sql)

    const at = new Date().toISOString()
    db.exec(`
      INSERT INTO boards (id, name, created_at, updated_at) VALUES ('b', 'Board', '${at}', '${at}');
      INSERT INTO columns (id, board_id, name, color, position) VALUES ('c', 'b', 'Todo', 'gray', 0);
      INSERT INTO tickets (id, board_id, column_id, number, title, position, created_at, updated_at)
        VALUES ('t', 'b', 'c', 1, 'Ticket', 0, '${at}', '${at}');
      INSERT INTO token_usage (id, board_id, ticket_id, agent, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd, created_at, routing_source)
        VALUES (7, 'b', 't', 'claude/opus/high', 1, 2, 3, 4, 0.5, '${at}', 'history');
      INSERT INTO token_usage_models (usage_id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd)
        VALUES (7, 'opus', 1, 2, 3, 4, 0.5);
    `)
    for (const sql of MIGRATIONS.slice(setNull)) db.exec(sql)

    const run = () =>
      db
        .prepare('SELECT id, ticket_id, cost_usd, routing_source FROM token_usage')
        .all()
        .map((row) => ({ ...row }))
    assert.deepEqual(run(), [{ id: 7, ticket_id: 't', cost_usd: 0.5, routing_source: 'history' }])
    assert.deepEqual(
      db
        .prepare('SELECT usage_id, model FROM token_usage_models')
        .all()
        .map((row) => ({ ...row })),
      [{ usage_id: 7, model: 'opus' }],
    )

    // Deleting the ticket keeps its run, with no ticket; deleting the board removes it.
    db.exec("DELETE FROM tickets WHERE id = 't'")
    assert.deepEqual(run(), [{ id: 7, ticket_id: null, cost_usd: 0.5, routing_source: 'history' }])
    assert.equal(db.prepare('SELECT count(*) AS n FROM token_usage_models').get()?.n, 1)
    db.exec("DELETE FROM boards WHERE id = 'b'")
    assert.deepEqual(run(), [])
    assert.equal(db.prepare('SELECT count(*) AS n FROM token_usage_models').get()?.n, 0)
  })
})
