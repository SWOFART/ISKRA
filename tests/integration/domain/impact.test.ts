import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ImpactSchema } from '../../../src/shared/contracts';
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

async function createUser(pool: Pool, id: string, balance = 0, version = 0) {
  await pool.query(
    'INSERT INTO users (id, nickname, rp_balance, version) VALUES ($1::text, $1::varchar, $2::int, $3::int)',
    [id, balance, version],
  );
}

interface ReportOptions {
  readonly status?: 'AWAITING_EXISTENCE' | 'VERIFIED' | 'AWAITING_RESOLUTION' | 'RESOLVED';
  readonly existenceYesCount?: number;
  readonly resolutionYesCount?: number;
  readonly isDemo?: boolean;
}

async function createReport(pool: Pool, authorId: string, options: ReportOptions = {}) {
  const status = options.status ?? 'AWAITING_EXISTENCE';
  const existenceYesCount = options.existenceYesCount ?? 0;
  const resolutionYesCount = options.resolutionYesCount ?? 0;
  const isDemo = options.isDemo ?? false;
  const analysis = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses (owner_user_id, kind, status, input_hash, result, expires_at, is_demo)
     VALUES ($1, 'REPORT', 'READY', $2, '{"decision":"ACCEPT"}'::jsonb, now() + interval '15 minutes', $3)
     RETURNING id`,
    [authorId, `impact-report-${crypto.randomUUID()}`, isDemo],
  );
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO reports (
       author_user_id, route, status, description, lat, lng, measured_lat, measured_lng,
       accuracy_m, captured_location_at, analysis_id, existence_yes_count,
       resolution_yes_count, existence_verified_at, last_existence_confirmed_at,
       resolved_at, is_demo
     ) VALUES (
       $1, 'GREEN', $2::report_lifecycle, 'Impact history report', 49.14, 9.22, 49.14, 9.22,
       10, now(), $3::uuid, $4, $5,
       CASE WHEN $4 >= 3 THEN now() - interval '2 minutes' ELSE NULL END,
       CASE WHEN $4 > 0 THEN now() - interval '1 minute' ELSE NULL END,
       CASE WHEN $2 = 'RESOLVED' THEN now() ELSE NULL END, $6
     ) RETURNING id`,
    [authorId, status, analysis.rows[0].id, existenceYesCount, resolutionYesCount, isDemo],
  );
  const reportId = inserted.rows[0].id;
  await pool.query(
    `INSERT INTO report_photos (
       owner_user_id, report_id, purpose, state, object_key, ordinal, mime_type, byte_size,
       sha256, upload_expires_at
     ) VALUES ($1, $2::uuid, 'REPORT', 'ATTACHED', $3, 0, 'image/jpeg', 128, $4, now() + interval '5 minutes')`,
    [authorId, reportId, `impact-report/${crypto.randomUUID()}`, 'a'.repeat(64)],
  );
  return reportId;
}

async function createCleanup(
  pool: Pool,
  reportId: string,
  cleanerId: string,
  status: 'AWAITING_VERIFICATION' | 'VERIFIED',
) {
  const analysis = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses (owner_user_id, kind, status, report_id, input_hash, result, expires_at)
     VALUES ($1, 'CLEANUP', 'READY', $2::uuid, $3, '{"decision":"ACCEPT"}'::jsonb,
       now() + interval '15 minutes') RETURNING id`,
    [cleanerId, reportId, `impact-cleanup-${crypto.randomUUID()}`],
  );
  const cleanup = await pool.query<{ id: string }>(
    `INSERT INTO cleanup_submissions (
       report_id, cleaner_user_id, analysis_id, status, lat, lng, accuracy_m,
       captured_location_at, verified_at
     ) VALUES ($1::uuid, $2, $3::uuid, $4::cleanup_status, 49.14, 9.22, 10, now(),
       CASE WHEN $4 = 'VERIFIED' THEN now() ELSE NULL END) RETURNING id`,
    [reportId, cleanerId, analysis.rows[0].id, status],
  );
  return cleanup.rows[0].id;
}

async function credit(pool: Pool, userId: string, kind: string, reportId: string, delta: number, voteId?: string) {
  await pool.query(
    `INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id, vote_id)
     VALUES ($1, $2::ledger_kind, $3, $4, $5::uuid, $6::uuid)`,
    [userId, kind, delta, `impact-credit-${crypto.randomUUID()}`, reportId, voteId ?? null],
  );
}

async function vote(pool: Pool, reportId: string, voterId: string, stage: 'EXISTENCE' | 'RESOLUTION', choice: 'YES' | 'NO') {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m)
     VALUES ($1::uuid, $2::vote_stage, $3, $4::vote_choice, 25, 5) RETURNING id`,
    [reportId, stage, voterId, choice],
  );
  await credit(pool, voterId, 'VOTE', reportId, 5, inserted.rows[0].id);
}

function createApp(pool: Pool) {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.route('/api', createDomainRoutes({
    database: new PostgresTransactionDatabase(pool),
    verify: async (token) => ({ uid: token }),
  }));
  app.onError(handleError);
  return app;
}

function getImpact(app: ReturnType<typeof createApp>, url = '/api/me/impact', token = 'impact-resident') {
  return app.request(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }, { FIREBASE_PROJECT_ID: 'impact-test-project' });
}

describe('PostgreSQL resident Impact projection', () => {
  it('keeps reporter and cleaner earnings separate, groups roles once, and counts YES/NO verification accurately', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all(['impact-resident', 'reporter-two', 'reporter-three']
        .map((id) => createUser(pool, id)));
      await pool.query('UPDATE users SET rp_balance = 35, version = 9 WHERE id = $1', ['impact-resident']);

      const selfCleaned = await createReport(pool, 'impact-resident', {
        status: 'RESOLVED', existenceYesCount: 3, resolutionYesCount: 3,
      });
      await createCleanup(pool, selfCleaned, 'impact-resident', 'VERIFIED');
      await credit(pool, 'impact-resident', 'REPORT_INITIAL', selfCleaned, 5);
      await credit(pool, 'impact-resident', 'REPORT_FINAL', selfCleaned, 15);
      await credit(pool, 'impact-resident', 'CLEANUP', selfCleaned, 40);

      const app = createApp(pool);
      const selfCleanImpact = ImpactSchema.parse(await (await getImpact(app)).json());
      expect(selfCleanImpact.reporter.earnedRp).toBe(20);
      expect(selfCleanImpact.cleaner.earnedRp).toBe(40);
      expect(selfCleanImpact.totals.earnedRp).toBe(60);
      expect(selfCleanImpact.items.filter((item) => item.report.id === selfCleaned)).toHaveLength(1);
      expect(selfCleanImpact.items.find((item) => item.report.id === selfCleaned)?.roles)
        .toEqual(['CLEANER', 'REPORTER']);

      const reporterInProgress = await createReport(pool, 'impact-resident');
      await credit(pool, 'impact-resident', 'REPORT_INITIAL', reporterInProgress, 5);

      const twoStageYesReport = await createReport(pool, 'reporter-two', {
        status: 'AWAITING_RESOLUTION', existenceYesCount: 3,
      });
      await vote(pool, twoStageYesReport, 'impact-resident', 'EXISTENCE', 'YES');
      await vote(pool, twoStageYesReport, 'impact-resident', 'RESOLUTION', 'YES');

      const afterTwoYes = ImpactSchema.parse(await (await getImpact(app)).json());
      expect(afterTwoYes.verification).toEqual({ acceptedVotes: 2, confirmedReports: 1, earnedRp: 10 });

      const noReport = await createReport(pool, 'reporter-three', { status: 'VERIFIED', existenceYesCount: 3 });
      await vote(pool, noReport, 'impact-resident', 'EXISTENCE', 'NO');
      const afterNo = ImpactSchema.parse(await (await getImpact(app)).json());
      expect(afterNo.verification).toEqual({ acceptedVotes: 3, confirmedReports: 1, earnedRp: 15 });

      const pendingCleanupReport = await createReport(pool, 'reporter-three', {
        status: 'AWAITING_RESOLUTION', existenceYesCount: 3,
      });
      await createCleanup(pool, pendingCleanupReport, 'impact-resident', 'AWAITING_VERIFICATION');

      const demoReport = await createReport(pool, 'impact-resident', { isDemo: true });
      await credit(pool, 'impact-resident', 'REPORT_INITIAL', demoReport, 5);
      await pool.query('UPDATE reward_ledger SET is_demo = true WHERE report_id = $1::uuid', [demoReport]);

      const response = await getImpact(app);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const body = ImpactSchema.parse(await response.json());

      expect(body.reporter).toEqual({ created: 2, inProgress: 1, resolved: 1, earnedRp: 25, pendingRp: 15 });
      expect(body.cleaner).toEqual({ submitted: 2, pending: 1, verified: 1, earnedRp: 40, pendingRp: 40 });
      expect(body.verification).toEqual({ acceptedVotes: 3, confirmedReports: 1, earnedRp: 15 });
      expect(body.totals).toEqual({ earnedRp: 80, balanceRp: 35 });
      expect(body.balanceVersion).toBe(9);
      expect(body.impactScore).toBeNull();
      expect(body.impactScoreState).toBe('NOT_CONFIGURED');
      expect(body.items).toHaveLength(5);

      const selfReportItems = body.items.filter((item) => item.report.id === selfCleaned);
      expect(selfReportItems).toHaveLength(1);
      expect(selfReportItems[0].roles).toEqual(['CLEANER', 'REPORTER']);
      expect(body.items.find((item) => item.report.id === twoStageYesReport)?.roles).toEqual(['VERIFIER']);
      expect(body.items.find((item) => item.report.id === noReport)?.roles).toEqual(['VERIFIER']);
      expect(body.items.some((item) => item.report.id === demoReport)).toBe(false);
      expect(body).not.toHaveProperty('votes');

      // A real redemption changes spendable RP, not the immutable positive category earnings.
      const catalog = await pool.query<{ id: string }>(
        `INSERT INTO reward_catalog (title, description, cost_rp)
         VALUES ('Demo item', 'No real-world value.', 23) RETURNING id`,
      );
      const redemption = await app.request(`/api/rewards/${catalog.rows[0].id}/redeem`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer impact-resident',
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ confirmedCostRp: 23 }),
      }, { FIREBASE_PROJECT_ID: 'impact-test-project' });
      expect(redemption.status).toBe(201);
      expect(await redemption.json()).toMatchObject({ balance: 12, rpDebited: 23 });
      const afterRedemption = ImpactSchema.parse(await (await getImpact(app)).json());
      expect(afterRedemption.totals).toEqual({ earnedRp: 80, balanceRp: 12 });
      expect(afterRedemption.verification).toEqual({ acceptedVotes: 3, confirmedReports: 1, earnedRp: 15 });
    }));

  it('requires authentication and rejects unknown, duplicate, or malformed cursor query input', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const app = createApp(pool);
      expect((await getImpact(app, '/api/me/impact', '')).status).toBe(401);
      expect((await getImpact(app, '/api/me/impact?include=private')).status).toBe(400);
      expect((await getImpact(app, '/api/me/impact?cursor=bad')).status).toBe(400);
      expect((await getImpact(app, '/api/me/impact?cursor=bad&cursor=again')).status).toBe(400);
      const empty = await getImpact(app);
      expect(empty.status).toBe(200);
      expect(ImpactSchema.parse(await empty.json())).toMatchObject({
        reporter: { created: 0, earnedRp: 0, pendingRp: 0 },
        cleaner: { submitted: 0, earnedRp: 0, pendingRp: 0 },
        verification: { acceptedVotes: 0, confirmedReports: 0, earnedRp: 0 },
        totals: { earnedRp: 0, balanceRp: 0 }, items: [], nextCursor: null,
      });
    }));
});
