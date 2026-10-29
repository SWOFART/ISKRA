import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  DemoRewardCatalogSchema,
  DemoRewardRedemptionReceiptSchema,
  DemoRewardVoucherListSchema,
} from '../../../src/shared/contracts';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { apiSecurity } from '../../../src/worker/middleware/security';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import { withTestDatabase } from '../auth/postgres';

const migrations = await Promise.all([
  readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../../migrations/0004_demo_rewards.sql', import.meta.url), 'utf8'),
]);

async function installSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const migration of migrations) await client.query(migration);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createUser(pool: Pool, id: string, balance = 0) {
  await pool.query(
    'INSERT INTO users (id, nickname, rp_balance) VALUES ($1::text, $2::varchar, $3::int)',
    [id, `Resident ${id}`, balance],
  );
}

async function createCatalogItem(pool: Pool, options: {
  readonly title?: string;
  readonly costRp?: number;
  readonly active?: boolean;
  readonly imageKey?: string | null;
} = {}) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO reward_catalog (title, description, image_key, cost_rp, active)
     VALUES ($1::varchar, 'A fictional demo item.', $2::varchar, $3::int, $4::boolean)
     RETURNING id`,
    [options.title ?? 'Demo recognition', options.imageKey ?? null, options.costRp ?? 20, options.active ?? true],
  );
  return result.rows[0].id;
}

function createApp(pool: Pool) {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.route('/api', createDomainRoutes({
    database: new PostgresTransactionDatabase(pool),
    verify: async (token) => ({ uid: token }),
  }));
  app.onError((error, context) => handleError(error, context));
  return app;
}

function getCatalog(app: Hono<WorkerEnv>, path = '/api/rewards/catalog') {
  return app.request(path);
}

function redeem(
  app: Hono<WorkerEnv>, actorId: string, itemId: string, key: string, confirmedCostRp: number,
) {
  return app.request(`/api/rewards/${itemId}/redeem`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${actorId}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ confirmedCostRp }),
  }, { FIREBASE_PROJECT_ID: 'rewards-test-project' });
}

function getVouchers(app: Hono<WorkerEnv>, actorId: string, path = '/api/me/vouchers') {
  return app.request(path, {
    headers: { Authorization: `Bearer ${actorId}` },
  }, { FIREBASE_PROJECT_ID: 'rewards-test-project' });
}

async function counts(pool: Pool, actorId: string) {
  const result = await pool.query<{
    vouchers: number;
    debits: number;
    claims: number;
    balance: number;
  }>(
    `SELECT (SELECT count(*)::int FROM user_vouchers WHERE user_id = $1) AS vouchers,
       (SELECT count(*)::int FROM reward_ledger WHERE user_id = $1 AND kind = 'REDEMPTION') AS debits,
       (SELECT count(*)::int FROM idempotency_keys WHERE user_id = $1 AND operation = 'DEMO_REWARD_REDEEM') AS claims,
       (SELECT rp_balance FROM users WHERE id = $1) AS balance`,
    [actorId],
  );
  return result.rows[0];
}

describe('atomic demo reward redemption', () => {
  it('lists active demo items without exposing storage keys or caching the catalog', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const activeId = await createCatalogItem(pool, { imageKey: 'private/reward-image-key' });
      await createCatalogItem(pool, { title: 'Inactive demo item', active: false });
      const app = createApp(pool);

      const response = await getCatalog(app);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const catalog = DemoRewardCatalogSchema.parse(await response.json());
      expect(catalog.items).toHaveLength(4);
      const createdItem = catalog.items.find((item) => item.id === activeId);
      expect(createdItem).toMatchObject({
        id: activeId,
        title: 'Demo recognition',
        costRp: 20,
        isDemo: true,
        demoTerms: expect.stringContaining('No real-world value'),
      });
      expect(createdItem).not.toHaveProperty('imageKey');
      expect(JSON.stringify(catalog)).not.toContain('private/reward-image-key');
      expect((await getCatalog(app, '/api/rewards/catalog?include=inactive')).status).toBe(400);
    }));

  it('debits once, replays the same voucher with the current balance and rejects a changed accepted payload', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const actor = 'reward-idempotency-resident';
      await createUser(pool, actor, 50);
      const itemId = await createCatalogItem(pool, { costRp: 20 });
      const key = crypto.randomUUID();
      const app = createApp(pool);

      const created = await redeem(app, actor, itemId, key, 20);
      expect(created.status).toBe(201);
      const receipt = DemoRewardRedemptionReceiptSchema.parse(await created.json());
      expect(receipt).toMatchObject({ balance: 30, balanceVersion: 1, rpDebited: 20 });
      expect(receipt.voucher).toMatchObject({
        catalogId: itemId,
        costRpSnapshot: 20,
        status: 'RECEIVED',
        isDemo: true,
        displayCode: `DEMO-${receipt.voucher.id.toUpperCase()}`,
      });
      expect(receipt.voucher.demoTerms).toContain('No real-world value');
      expect(receipt.voucher.displayCode).not.toContain('https://');
      expect(await counts(pool, actor)).toEqual({ vouchers: 1, debits: 1, claims: 1, balance: 30 });
      const debit = await pool.query<{ delta: number; is_demo: boolean; voucher_id: string }>(
        `SELECT delta, is_demo, voucher_id FROM reward_ledger
         WHERE user_id = $1 AND kind = 'REDEMPTION'`, [actor],
      );
      expect(debit.rows[0]).toEqual({ delta: -20, is_demo: true, voucher_id: receipt.voucher.id });

      await pool.query('UPDATE users SET rp_balance = 25, version = version + 1 WHERE id = $1', [actor]);
      const replay = await redeem(app, actor, itemId, key, 20);
      expect(replay.status).toBe(201);
      expect(DemoRewardRedemptionReceiptSchema.parse(await replay.json())).toMatchObject({
        voucher: { id: receipt.voucher.id }, balance: 25, balanceVersion: 2, rpDebited: 20,
      });
      expect(await counts(pool, actor)).toEqual({ vouchers: 1, debits: 1, claims: 1, balance: 25 });

      const conflict = await redeem(app, actor, itemId, key, 21);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect(await counts(pool, actor)).toEqual({ vouchers: 1, debits: 1, claims: 1, balance: 25 });
    }));

  it('does not claim a stale-price key and permits explicit reconfirmation after refresh', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const actor = 'reward-price-resident';
      await createUser(pool, actor, 100);
      const itemId = await createCatalogItem(pool, { costRp: 20 });
      const key = crypto.randomUUID();
      const app = createApp(pool);

      await pool.query('UPDATE reward_catalog SET cost_rp = 25 WHERE id = $1::uuid', [itemId]);
      const stale = await redeem(app, actor, itemId, key, 20);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: 'PRICE_CHANGED' } });
      expect(await counts(pool, actor)).toEqual({ vouchers: 0, debits: 0, claims: 0, balance: 100 });

      const confirmed = await redeem(app, actor, itemId, key, 25);
      expect(confirmed.status).toBe(201);
      expect(DemoRewardRedemptionReceiptSchema.parse(await confirmed.json())).toMatchObject({
        balance: 75, rpDebited: 25, voucher: { costRpSnapshot: 25 },
      });
      expect(await counts(pool, actor)).toEqual({ vouchers: 1, debits: 1, claims: 1, balance: 75 });
    }));

  it('serializes different-key purchases so two concurrent redemptions cannot overspend', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const actor = 'reward-race-resident';
      await createUser(pool, actor, 40);
      const itemId = await createCatalogItem(pool, { costRp: 40 });
      const app = createApp(pool);
      const responses = await Promise.all([
        redeem(app, actor, itemId, crypto.randomUUID(), 40),
        redeem(app, actor, itemId, crypto.randomUUID(), 40),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const rejected = responses.find((response) => response.status === 409)!;
      expect(await rejected.json()).toMatchObject({ error: { code: 'INSUFFICIENT_RP' } });
      expect(await counts(pool, actor)).toEqual({ vouchers: 1, debits: 1, claims: 1, balance: 0 });
    }));

  it('denies insufficient and negative balances without clamping or creating any receipt', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const itemId = await createCatalogItem(pool, { costRp: 10 });
      const app = createApp(pool);
      for (const [actor, balance] of [['reward-poor-resident', 5], ['reward-negative-resident', -3]] as const) {
        await createUser(pool, actor, balance);
        const response = await redeem(app, actor, itemId, crypto.randomUUID(), 10);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_RP' } });
        expect(await counts(pool, actor)).toEqual({ vouchers: 0, debits: 0, claims: 0, balance });
      }
    }));

  it('keeps vouchers private to their authenticated owner and requires auth', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const owner = 'reward-voucher-owner';
      const other = 'reward-voucher-other';
      await createUser(pool, owner, 30);
      await createUser(pool, other, 30);
      const itemId = await createCatalogItem(pool, { costRp: 10 });
      const app = createApp(pool);
      const created = await redeem(app, owner, itemId, crypto.randomUUID(), 10);
      expect(created.status).toBe(201);

      const ownerResponse = await getVouchers(app, owner);
      expect(ownerResponse.status).toBe(200);
      const ownerList = DemoRewardVoucherListSchema.parse(await ownerResponse.json());
      expect(ownerList.items).toHaveLength(1);
      expect(ownerList.items[0]).toMatchObject({ catalogId: itemId, isDemo: true, status: 'RECEIVED' });
      expect(ownerResponse.headers.get('Cache-Control')).toBe('no-store');

      const otherResponse = await getVouchers(app, other);
      expect(DemoRewardVoucherListSchema.parse(await otherResponse.json()).items).toEqual([]);
      expect((await getVouchers(app, owner, '/api/me/vouchers?include=other')).status).toBe(400);
      expect((await getVouchers(app, owner, '/api/me/vouchers?cursor=bad')).status).toBe(400);
      expect((await getVouchers(app, '', '/api/me/vouchers')).status).toBe(401);
      expect((await app.request(`/api/rewards/${itemId}/redeem`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ confirmedCostRp: 10 }),
      })).status).toBe(401);
    }));
});
