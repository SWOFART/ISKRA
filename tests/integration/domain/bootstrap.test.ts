import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const trustedUid = 'firebase-resident-uid-17';
const projectId = 'iskra-bootstrap-test';

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

function createTestApp(pool: Pool) {
  const claims = {
    uid: trustedUid,
    email: 'private@example.test',
    name: 'Private Provider Name',
  };
  const verify = async (token: string, configuredProject: string) => {
    if (token !== 'valid-firebase-token' || configuredProject !== projectId) {
      throw new Error('Invalid test token');
    }
    return claims;
  };
  const app = new Hono<WorkerEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', '11111111-1111-4111-8111-111111111111');
    await next();
  });
  app.route('/api', createDomainRoutes({ database: new PostgresTransactionDatabase(pool), verify }));
  app.onError(handleError);
  return app;
}

function bootstrap(app: ReturnType<typeof createTestApp>, body = '{}', token = 'valid-firebase-token') {
  return app.request('/api/me/bootstrap', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  }, { FIREBASE_PROJECT_ID: projectId });
}

describe('resident account bootstrap', () => {
  it('uses the verified UID, keeps provider claims private, and returns the existing account on repeat', () => withTestDatabase(async (pool) => {
    await installSchema(pool);
    const app = createTestApp(pool);

    const [firstResponse, concurrentResponse] = await Promise.all([bootstrap(app), bootstrap(app)]);
    expect(firstResponse.status).toBe(200);
    expect(concurrentResponse.status).toBe(200);
    const first = await firstResponse.json() as Record<string, unknown>;
    const concurrent = await concurrentResponse.json() as Record<string, unknown>;
    const firstUser = first.user as Record<string, unknown>;
    const concurrentUser = concurrent.user as Record<string, unknown>;

    expect(firstUser).toEqual({ id: trustedUid, nickname: expect.stringMatching(/^Resident-[0-9a-f]{8}$/), avatar: 'avatar-default' });
    expect(concurrentUser).toEqual(firstUser);
    expect(first).toEqual({ user: firstUser, balance: 0, balanceVersion: 0 });
    expect(firstResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(firstUser).not.toHaveProperty('email');
    expect(firstUser).not.toHaveProperty('name');
    expect(first).not.toHaveProperty('email');
    expect(first).not.toHaveProperty('name');
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM users WHERE id = $1::text', [trustedUid],
    )).rows[0].count).toBe(1);

    await pool.query(
      'UPDATE users SET rp_balance = 9, version = 2 WHERE id = $1::text', [trustedUid],
    );
    const repeatedResponse = await bootstrap(app);
    expect(repeatedResponse.status).toBe(200);
    expect(await repeatedResponse.json()).toEqual({ user: firstUser, balance: 9, balanceVersion: 2 });

    const injected = await bootstrap(app, JSON.stringify({ uid: 'attacker-controlled-uid' }));
    expect(injected.status).toBe(400);
    expect((await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM users WHERE id = $1::text', ['attacker-controlled-uid'],
    )).rows[0].count).toBe(0);

    const unauthenticated = await app.request('/api/me/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, { FIREBASE_PROJECT_ID: projectId });
    expect(unauthenticated.status).toBe(401);
  }));
});
