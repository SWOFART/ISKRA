import { describe, expect, it, vi } from 'vitest';
import type { CheckedOutClient, QueryResult, TransactionDatabase } from '../../../src/worker/db/client';
import {
  createRequestScopedDatabase,
  type RequestPostgresClient,
} from '../../../src/worker/db/runtime';
import { createWorkerHandler } from '../../../src/worker';

describe('Worker Hyperdrive runtime', () => {
  it('mounts bootstrap with the request Hyperdrive database and closes the request scope', async () => {
    const close = vi.fn(async () => undefined);
    const createDatabase = vi.fn(() => ({ database: successfulBootstrapDatabase(), close }));
    const verify = vi.fn(async () => ({ uid: 'verified-resident' }));
    const worker = createWorkerHandler({ createDatabase, verify });

    const response = await worker.fetch(new Request('https://iskra.test/api/me/bootstrap', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
      body: '{}',
    }), {
      FIREBASE_PROJECT_ID: 'iskra-test',
      HYPERDRIVE: { connectionString: 'postgres://hyperdrive.test/iskra' },
    }, {} as ExecutionContext);

    expect(createDatabase).toHaveBeenCalledWith('postgres://hyperdrive.test/iskra');
    expect(verify).toHaveBeenCalledWith('valid-token', 'iskra-test');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { id: 'verified-resident', nickname: 'Resident-1234abcd', avatar: 'avatar-default' },
      balance: 0,
      balanceVersion: 0,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps bootstrap unavailable when the runtime has no Hyperdrive binding', async () => {
    const createDatabase = vi.fn();
    const worker = createWorkerHandler({ createDatabase });
    const response = await worker.fetch(new Request('https://iskra.test/api/me/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }), { FIREBASE_PROJECT_ID: 'iskra-test' }, {} as ExecutionContext);

    expect(response.status).toBe(503);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('uses one lazy pg client for transactions and closes it after the Worker request', async () => {
    const calls: string[] = [];
    const connect = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const client: RequestPostgresClient = {
      connect,
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string) {
        calls.push(text);
        return { rows: [] as Row[], rowCount: 0, command: text };
      },
      end,
    };
    const createClient = vi.fn(() => client);
    const runtime = createRequestScopedDatabase('postgres://hyperdrive.test/iskra', createClient);

    expect(createClient).toHaveBeenCalledWith('postgres://hyperdrive.test/iskra');
    expect(connect).not.toHaveBeenCalled();
    await runtime.database.withTransaction(async (databaseClient) => databaseClient.query('SELECT 1'));
    await runtime.close();

    expect(connect).toHaveBeenCalledOnce();
    expect(calls).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(end).toHaveBeenCalledOnce();
  });
});

function successfulBootstrapDatabase(): TransactionDatabase {
  return {
    async withTransaction<T>(work: (client: CheckedOutClient) => Promise<T>): Promise<T> {
      const client: CheckedOutClient = {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(): Promise<QueryResult<Row>> {
          return {
            rows: [{
              id: 'verified-resident',
              nickname: 'Resident-1234abcd',
              avatar_key: 'avatar-default',
              rp_balance: 0,
              version: 0,
            } as unknown as Row],
            rowCount: 1,
          };
        },
      };
      return work(client);
    },
  };
}
