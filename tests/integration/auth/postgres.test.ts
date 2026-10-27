import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { testDatabaseConfig, withTestDatabase } from './postgres';

describe('disposable real PostgreSQL harness', () => {
  it('connects to PostgreSQL with an isolated schema', () => withTestDatabase(async (pool) => {
    const { rows } = await pool.query('SELECT version(), current_schema() AS schema');
    expect(rows[0].version).toContain('PostgreSQL');
    expect(rows[0].schema).toMatch(/^iskra_test_[a-f0-9]{32}$/);
  }));

  it('rolls back all statements after a constraint failure on one checked-out client', () => withTestDatabase(async (pool) => {
    await pool.query('CREATE TABLE harness_ledger (operation text UNIQUE, delta integer CHECK (delta <> 0))');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO harness_ledger VALUES ('same', 5)");
      await expect(client.query("INSERT INTO harness_ledger VALUES ('same', 5)"))
        .rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await pool.query('SELECT count(*)::int AS count FROM harness_ledger')).rows[0].count).toBe(0);
  }));

  it('enforces uniqueness across simultaneous connections', () => withTestDatabase(async (pool) => {
    await pool.query('CREATE TABLE harness_ledger (operation text UNIQUE, delta integer NOT NULL)');
    const results = await Promise.allSettled([
      pool.query("INSERT INTO harness_ledger VALUES ('same', 5)"),
      pool.query("INSERT INTO harness_ledger VALUES ('same', 5)"),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS count, sum(delta)::int AS balance FROM harness_ledger')).rows[0])
      .toEqual({ count: 1, balance: 5 });
  }));

  it('removes its own schema even when the test callback fails', async () => {
    let schema = '';
    await expect(withTestDatabase(async (pool) => {
      schema = (await pool.query('SELECT current_schema() AS schema')).rows[0].schema;
      throw new Error('controlled test failure');
    })).rejects.toThrow('controlled test failure');
    const client = new Client(testDatabaseConfig());
    await client.connect();
    try {
      expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it.runIf(process.env.ISKRA_TEST_INJECT_FAILURE === '1')('detects an intentionally violated SQL invariant', () => withTestDatabase(async (pool) => {
    const { rows } = await pool.query('SELECT 1::int AS actual');
    expect(rows[0].actual, 'ISKRA_HARNESS_EXPECTED_FAILURE').toBe(2);
  }));
});
