import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  AccountNotFoundError,
  executeIdempotently,
  IdempotencyConflictError,
  lockAccounts,
  PostgresTransactionDatabase,
  TransactionAbortedError,
} from '../../../src/worker/db/client';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');

async function installSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(migration);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, nickname) VALUES ($1::text, $2::varchar)', [id, 'Test User']);
}

describe('PostgreSQL transaction primitives', () => {
  it('uses one checked-out client and rolls back the key and mutation together', () => withTestDatabase(async (pool) => {
    await installSchema(pool);
    const actorId = 'transaction-rollback-user';
    await createUser(pool, actorId);

    let connectCount = 0;
    const database = new PostgresTransactionDatabase({
      connect: async () => {
        connectCount += 1;
        return pool.connect();
      },
    });
    const backendPids: number[] = [];
    const request = {
      actorId,
      operation: 'transaction-rollback-test',
      key: crypto.randomUUID(),
      requestHash: 'rollback-payload-hash',
    };

    await expect(executeIdempotently(
      database,
      request,
      async (client) => {
        await client.query('UPDATE users SET rp_balance = rp_balance + 5 WHERE id = $1::text', [actorId]);
        backendPids.push((await client.query<{ backend_pid: number }>(
          'SELECT pg_backend_pid()::int AS backend_pid',
        )).rows[0].backend_pid);
        backendPids.push((await client.query<{ backend_pid: number }>(
          'SELECT pg_backend_pid()::int AS backend_pid',
        )).rows[0].backend_pid);
        throw new Error('controlled transaction failure');
      },
      async () => {
        throw new Error('a newly claimed key must not replay');
      },
    )).rejects.toThrow('controlled transaction failure');

    expect(connectCount).toBe(1);
    expect(backendPids).toHaveLength(2);
    expect(new Set(backendPids).size).toBe(1);
    expect((await pool.query<{ rp_balance: number }>(
      'SELECT rp_balance FROM users WHERE id = $1::text', [actorId],
    )).rows[0].rp_balance).toBe(0);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM idempotency_keys
       WHERE user_id = $1::text AND operation = $2::varchar AND key = $3::varchar`,
      [actorId, request.operation, request.key],
    )).rows[0].count).toBe(0);
  }));

  it('does not report success when a callback catches a SQL error and PostgreSQL rolls back at COMMIT', () => withTestDatabase(async (pool) => {
    await installSchema(pool);
    const actorId = 'caught-sql-error-user';
    await createUser(pool, actorId);
    const database = new PostgresTransactionDatabase(pool);

    await expect(database.withTransaction(async (client) => {
      await client.query('UPDATE users SET rp_balance = rp_balance + 5 WHERE id = $1::text', [actorId]);
      try {
        await client.query('SELECT 1 / 0');
      } catch {
        // Simulate a callback swallowing a query failure while PostgreSQL marks the transaction aborted.
      }
      return 'callback returned a value despite the aborted transaction';
    })).rejects.toBeInstanceOf(TransactionAbortedError);

    expect((await pool.query<{ rp_balance: number }>(
      'SELECT rp_balance FROM users WHERE id = $1::text', [actorId],
    )).rows[0].rp_balance).toBe(0);
  }));

  it('replays through a fresh canonical read, rejects conflicting payloads, and stores no old response body', () => withTestDatabase(async (pool) => {
    await installSchema(pool);
    const actorId = 'idempotency-current-state-user';
    await createUser(pool, actorId);
    const database = new PostgresTransactionDatabase(pool);
    const request = {
      actorId,
      operation: 'test-balance-increment',
      key: crypto.randomUUID(),
      requestHash: 'normalized-payload-v1',
    };
    const resourceId = crypto.randomUUID();
    let executionCount = 0;

    const first = await executeIdempotently(
      database,
      request,
      async (client) => {
        executionCount += 1;
        const update = await client.query<{ id: string; rp_balance: number; version: number }>(
          `UPDATE users SET rp_balance = rp_balance + 5, version = version + 1
           WHERE id = $1::text RETURNING id, rp_balance, version`,
          [actorId],
        );
        const user = update.rows[0];
        return {
          value: { balance: user.rp_balance, balanceVersion: user.version },
          receipt: { resourceId, responseStatus: 201 },
        };
      },
      async () => {
        throw new Error('first use must execute the mutation');
      },
    );

    expect(first).toEqual({ value: { balance: 5, balanceVersion: 1 }, responseStatus: 201, replayed: false });
    await pool.query(
      'UPDATE users SET rp_balance = rp_balance + 7, version = version + 1 WHERE id = $1::text',
      [actorId],
    );

    const replay = await executeIdempotently(
      database,
      request,
      async () => {
        executionCount += 1;
        throw new Error('a replay must not execute the mutation again');
      },
      async (client, receipt) => {
        expect(receipt.resourceId).toBe(resourceId);
        const current = await client.query<{ rp_balance: number; version: number }>(
          'SELECT rp_balance, version FROM users WHERE id = $1::text',
          [actorId],
        );
        return { balance: current.rows[0].rp_balance, balanceVersion: current.rows[0].version };
      },
    );

    expect(replay).toEqual({ value: { balance: 12, balanceVersion: 2 }, responseStatus: 201, replayed: true });
    expect(executionCount).toBe(1);
    expect((await pool.query<{ response_body_is_null: boolean }>(
      `SELECT response_body IS NULL AS response_body_is_null FROM idempotency_keys
       WHERE user_id = $1::text AND operation = $2::varchar AND key = $3::varchar`,
      [actorId, request.operation, request.key],
    )).rows[0].response_body_is_null).toBe(true);

    await expect(executeIdempotently(
      database,
      { ...request, requestHash: 'different-payload-hash' },
      async () => {
        executionCount += 1;
        throw new Error('a conflicting payload must not execute');
      },
      async () => ({ balance: -1, balanceVersion: -1 }),
    )).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(executionCount).toBe(1);
    expect((await pool.query<{ rp_balance: number }>(
      'SELECT rp_balance FROM users WHERE id = $1::text', [actorId],
    )).rows[0].rp_balance).toBe(12);
  }));

  it('locks unique account IDs in stable order and fails when any account is missing', () => withTestDatabase(async (pool) => {
    await installSchema(pool);
    await createUser(pool, 'zeta-account');
    await createUser(pool, 'alpha-account');
    const database = new PostgresTransactionDatabase(pool);

    const locked = await database.withTransaction((client) => lockAccounts(
      client,
      ['zeta-account', 'alpha-account', 'zeta-account'],
    ));
    expect(locked).toEqual(['alpha-account', 'zeta-account']);

    await expect(database.withTransaction((client) => lockAccounts(
      client,
      ['alpha-account', 'missing-account'],
    ))).rejects.toBeInstanceOf(AccountNotFoundError);
  }));
});
