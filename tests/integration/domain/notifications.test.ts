import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { NotificationListSchema, NotificationReadReceiptSchema } from '../../../src/shared/contracts';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { apiSecurity } from '../../../src/worker/middleware/security';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');

async function installSchema(pool: Pool) {
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

async function createUser(pool: Pool, id: string) {
  await pool.query('INSERT INTO users (id, nickname) VALUES ($1::text, $1::varchar)', [id]);
}

async function createReport(pool: Pool, authorId: string) {
  const analysis = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses (owner_user_id, kind, status, input_hash, result, expires_at)
     VALUES ($1::text, 'REPORT', 'READY', $2::varchar, '{"decision":"ACCEPT"}'::jsonb,
       now() + interval '15 minutes') RETURNING id`,
    [authorId, `notification-report-${crypto.randomUUID()}`],
  );
  const report = await pool.query<{ id: string }>(
    `INSERT INTO reports (
       author_user_id, route, status, description, lat, lng, measured_lat, measured_lng,
       accuracy_m, captured_location_at, analysis_id, existence_yes_count, resolution_yes_count,
       existence_verified_at, last_existence_confirmed_at, resolved_at
     ) VALUES (
       $1::text, 'GREEN', 'RESOLVED', 'Notification test report', 49.14, 9.22, 49.14, 9.22,
       10, now(), $2::uuid, 3, 3, now() - interval '2 minutes',
       now() - interval '1 minute', now()
     ) RETURNING id`,
    [authorId, analysis.rows[0].id],
  );
  return report.rows[0].id;
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

const environment = { FIREBASE_PROJECT_ID: 'notifications-test-project' };

function request(
  app: ReturnType<typeof createApp>,
  url: string,
  actor = 'notification-owner',
) {
  return app.request(url, { headers: { Authorization: `Bearer ${actor}` } }, environment);
}

async function seedPage(pool: Pool, ownerId: string, count: number) {
  const reportIds = Array.from({ length: count }, () => crypto.randomUUID());
  const analysisIds = Array.from({ length: count }, () => crypto.randomUUID());
  await pool.query(
    `INSERT INTO ai_analyses (id, owner_user_id, kind, status, input_hash, result, expires_at)
     SELECT seed.analysis_id, $1::text, 'REPORT', 'READY', seed.analysis_id::text,
       '{"decision":"ACCEPT"}'::jsonb, now() + interval '15 minutes'
     FROM unnest($2::uuid[]) WITH ORDINALITY AS seed(report_id, ordinality)
     JOIN unnest($3::uuid[]) WITH ORDINALITY AS analyses(analysis_id, ordinality)
       USING (ordinality)`,
    [ownerId, reportIds, analysisIds],
  );
  await pool.query(
    `INSERT INTO reports (
       id, author_user_id, route, status, description, lat, lng, measured_lat, measured_lng,
       accuracy_m, captured_location_at, analysis_id, existence_yes_count,
       existence_verified_at, last_existence_confirmed_at
     )
     SELECT seed.report_id, $1::text, 'GREEN', 'VERIFIED', 'Notification page report',
       49.14, 9.22, 49.14, 9.22, 10, now(), seed.analysis_id, 3,
       now() - interval '2 minutes', now() - interval '1 minute'
     FROM unnest($2::uuid[]) WITH ORDINALITY AS seed(report_id, ordinality)
     JOIN unnest($3::uuid[]) WITH ORDINALITY AS analyses(analysis_id, ordinality)
       USING (ordinality)`,
    [ownerId, reportIds, analysisIds],
  );
  await pool.query(
    `INSERT INTO notifications (user_id, report_id, kind, message)
     SELECT $1::text, report_id, 'EXISTENCE_VERIFIED', 'Residents confirmed your report.'
     FROM unnest($2::uuid[]) AS reports(report_id)`,
    [ownerId, reportIds],
  );
}

describe('PostgreSQL resident notifications', () => {
  it('returns only the owner’s kind-based localized messages and marks reads idempotently', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all(['notification-owner', 'notification-other'].map((id) => createUser(pool, id)));
      const reportId = await createReport(pool, 'notification-owner');
      const existence = await pool.query<{ id: string }>(
        `INSERT INTO notifications (user_id, report_id, kind, message)
         VALUES ('notification-owner', $1::uuid, 'EXISTENCE_VERIFIED', 'Stored source text') RETURNING id`,
        [reportId],
      );
      const resolution = await pool.query<{ id: string }>(
        `INSERT INTO notifications (user_id, report_id, kind, message)
         VALUES ('notification-owner', $1::uuid, 'REPORT_RESOLVED', 'Stored source text') RETURNING id`,
        [reportId],
      );
      const other = await pool.query<{ id: string }>(
        `INSERT INTO notifications (user_id, report_id, kind, message)
         VALUES ('notification-other', $1::uuid, 'EXISTENCE_VERIFIED', 'Private other message') RETURNING id`,
        [reportId],
      );
      const app = createApp(pool);

      const englishResponse = await request(app, '/api/me/notifications');
      expect(englishResponse.status).toBe(200);
      expect(englishResponse.headers.get('Cache-Control')).toBe('no-store');
      const english = NotificationListSchema.parse(await englishResponse.json());
      expect(english.nextCursor).toBeNull();
      expect(english.items).toHaveLength(2);
      const byKind = new Map(english.items.map((item) => [item.kind, item]));
      expect(byKind.get('EXISTENCE_VERIFIED')).toMatchObject({
        id: existence.rows[0].id,
        message: 'Residents confirmed your report.',
        reportId,
        readAt: null,
      });
      expect(byKind.get('REPORT_RESOLVED')).toMatchObject({
        id: resolution.rows[0].id,
        message: 'Your city is cleaner thanks to you!',
        reportId,
        readAt: null,
      });
      expect(english.items.some((item) => item.id === other.rows[0].id)).toBe(false);

      const german = NotificationListSchema.parse(await (await request(app, '/api/me/notifications?locale=de')).json());
      expect(german.items.map(({ id, kind }) => ({ id, kind })))
        .toEqual(english.items.map(({ id, kind }) => ({ id, kind })));
      expect(new Map(german.items.map((item) => [item.kind, item])).get('EXISTENCE_VERIFIED')?.message)
        .toBe('Die Bewohner haben deinen Bericht bestätigt.');
      expect(new Map(german.items.map((item) => [item.kind, item])).get('REPORT_RESOLVED')?.message)
        .toBe('Dank dir ist deine Stadt sauberer!');

      const readUrl = `/api/me/notifications/${existence.rows[0].id}`;
      const sendRead = () => app.request(readUrl, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer notification-owner', 'Content-Type': 'application/json' },
        body: '{"read":true}',
      }, environment);
      const firstReadResponse = await sendRead();
      expect(firstReadResponse.status).toBe(200);
      const firstRead = NotificationReadReceiptSchema.parse(await firstReadResponse.json());
      expect(firstRead).toMatchObject({ id: existence.rows[0].id });
      const repeatedRead = NotificationReadReceiptSchema.parse(await (await sendRead()).json());
      expect(repeatedRead).toEqual(firstRead);

      const hiddenFromOther = await app.request(readUrl, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer notification-other', 'Content-Type': 'application/json' },
        body: '{"read":true}',
      }, environment);
      expect(hiddenFromOther.status).toBe(404);
      expect(await hiddenFromOther.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

      const databaseState = await pool.query<{ rows: number; owner_read: Date | string | null; other_read: Date | string | null }>(
        `SELECT count(*)::int AS rows,
           (SELECT read_at FROM notifications WHERE id = $1::uuid) AS owner_read,
           (SELECT read_at FROM notifications WHERE id = $2::uuid) AS other_read
         FROM notifications`,
        [existence.rows[0].id, other.rows[0].id],
      );
      expect(databaseState.rows[0].rows).toBe(3);
      expect(databaseState.rows[0].owner_read).not.toBeNull();
      expect(databaseState.rows[0].other_read).toBeNull();

      expect((await request(app, '/api/me/notifications?locale=fr')).status).toBe(400);
      expect((await request(app, '/api/me/notifications?locale=en&locale=de')).status).toBe(400);
      expect((await request(app, '/api/me/notifications?unsupported=1')).status).toBe(400);
      expect((await request(app, '/api/me/notifications?cursor=bad')).status).toBe(400);
      expect((await request(app, '/api/me/notifications?cursor=bad&cursor=again')).status).toBe(400);
      expect((await app.request('/api/me/notifications', {}, environment)).status).toBe(401);

      const invalidPath = await app.request('/api/me/notifications/not-a-uuid', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer notification-owner', 'Content-Type': 'application/json' },
        body: '{"read":true}',
      }, environment);
      expect(invalidPath.status).toBe(400);
      const invalidBody = await app.request(`/api/me/notifications/${resolution.rows[0].id}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer notification-owner', 'Content-Type': 'application/json' },
        body: '{"read":false}',
      }, environment);
      expect(invalidBody.status).toBe(400);
    }));

  it('paginates at the contract limit with immutable creation-time and UUID ordering', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await createUser(pool, 'notification-owner');
      await seedPage(pool, 'notification-owner', 101);
      const app = createApp(pool);
      const first = NotificationListSchema.parse(await (await request(app, '/api/me/notifications')).json());
      expect(first.items).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();
      const secondUrl = `/api/me/notifications?cursor=${encodeURIComponent(first.nextCursor!)}`;
      const second = NotificationListSchema.parse(await (await request(app, secondUrl)).json());
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(first.items.map((item) => item.id)).not.toContain(second.items[0].id);
    }));
});
