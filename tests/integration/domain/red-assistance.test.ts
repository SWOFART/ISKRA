import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { RedDraftEnvelopeSchema, RedSentDeclarationSchema } from '../../../src/shared/contracts';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { apiSecurity } from '../../../src/worker/middleware/security';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import { withTestDatabase } from '../auth/postgres';

const coreMigration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const missionMigration = await readFile(new URL('../../../migrations/0002_yellow_missions.sql', import.meta.url), 'utf8');
const redMigration = await readFile(new URL('../../../migrations/0003_red_assistance_drafts.sql', import.meta.url), 'utf8');

async function installSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(coreMigration);
    await client.query(missionMigration);
    await client.query(redMigration);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createUser(pool: Pool, id: string) {
  await pool.query('INSERT INTO users (id, nickname, avatar_key) VALUES ($1, $2, $3)', [
    id, 'Resident ' + id, 'avatar-default',
  ]);
}

async function createReport(
  pool: Pool,
  author: string,
  options: { route?: 'GREEN' | 'YELLOW' | 'RED'; demo?: boolean } = {},
) {
  const analysis = await pool.query<{ id: string }>(
    'INSERT INTO ai_analyses (owner_user_id, kind, status, input_hash, result, expires_at, is_demo) VALUES ($1, $2, $3, $4, $5::jsonb, now() + interval \'15 minutes\', $6) RETURNING id',
    [author, 'REPORT', 'READY', 'red-report-' + crypto.randomUUID(), '{"decision":"ACCEPT"}', options.demo ?? false],
  );
  const report = await pool.query<{ id: string }>(
    'INSERT INTO reports (author_user_id, route, status, description, lat, lng, measured_lat, measured_lng, accuracy_m, captured_location_at, analysis_id, is_demo) VALUES ($1, $2::report_route, $3::report_lifecycle, $4, $5, $6, $7, $8, $9, now(), $10::uuid, $11) RETURNING id',
    [author, options.route ?? 'RED', 'AWAITING_EXISTENCE', 'Loose chemical container beside the path',
      49.142, 9.225, 49.142, 9.225, 10, analysis.rows[0].id, options.demo ?? false],
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

function send(app: Hono<WorkerEnv>, path: string, method: string, actor: string | null, body?: unknown) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (actor) headers.set('Authorization', 'Bearer ' + actor);
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { FIREBASE_PROJECT_ID: 'test-project' });
}

describe('resident-owned Red assistance on PostgreSQL', () => {
  it('creates a factual private draft once, preserves edits, and only exposes provenance-backed contacts', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all(['owner', 'other'].map((id) => createUser(pool, id)));
      const reportId = await createReport(pool, 'owner');
      await pool.query(
        'INSERT INTO red_verified_contacts (city_id, locale, label, channel, value, source_label, source_url, verified_at, active) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), true)',
        ['heilbronn', 'de', 'Fixture contact', 'WEBSITE', 'https://example.invalid/contact',
          'Integration test fixture', 'https://example.invalid/source'],
      );
      await pool.query(
        'INSERT INTO red_verified_contacts (city_id, locale, label, channel, value, source_label, source_url, verified_at, active) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), false)',
        ['heilbronn', 'de', 'Inactive fixture', 'EMAIL', 'nobody@example.invalid',
          'Inactive integration fixture', 'https://example.invalid/inactive'],
      );
      const app = createApp(pool);
      const path = '/api/reports/' + reportId + '/red-draft';

      expect((await send(app, path, 'POST', null, { locale: 'de' })).status).toBe(401);
      expect((await send(app, path, 'GET', 'owner')).status).toBe(404);
      expect((await send(app, path, 'GET', 'not-bootstrapped')).status).toBe(404);

      const concurrentCreates = await Promise.all([
        send(app, path, 'POST', 'owner', { locale: 'de' }),
        send(app, path, 'POST', 'owner', { locale: 'de' }),
      ]);
      expect(concurrentCreates.map(({ status }) => status).sort()).toEqual([200, 201]);
      const drafts = await Promise.all(concurrentCreates.map(async (response) =>
        RedDraftEnvelopeSchema.parse(await response.json()).draft));
      expect(drafts[0]).toEqual(drafts[1]);
      const draft = drafts[0];
      expect(draft).toMatchObject({
        reportId,
        locale: 'de',
        sentAt: null,
        contacts: [{
          label: 'Fixture contact',
          channel: 'WEBSITE',
          value: 'https://example.invalid/contact',
          sourceLabel: 'Integration test fixture',
          sourceUrl: 'https://example.invalid/source',
        }],
      });
      expect(draft.text).toContain('Beschreibung aus meinem Bericht: Loose chemical container beside the path');
      expect(draft.text).toContain('Kartenmarkierung des Berichts: 49.14200, 9.22500');
      expect(draft.text).not.toMatch(/officially confirmed|sent by the app|received/i);
      expect(draft.contacts).toHaveLength(1);

      const editedText = 'Nur die beobachteten Fakten.\nKeine automatische Meldung.';
      const edited = await send(app, path, 'PATCH', 'owner', { text: editedText });
      expect(edited.status).toBe(200);
      expect(RedDraftEnvelopeSchema.parse(await edited.json()).draft.text).toBe(editedText);

      const createReplay = await send(app, path, 'POST', 'owner', { locale: 'en' });
      expect(createReplay.status).toBe(200);
      expect(RedDraftEnvelopeSchema.parse(await createReplay.json()).draft).toMatchObject({
        locale: 'de',
        text: editedText,
      });
      expect(RedDraftEnvelopeSchema.safeParse({
        ...draft,
        unexpected: 'private',
      }).success).toBe(false);
      expect((await send(app, path, 'PATCH', 'owner', { text: '', userId: 'other' })).status).toBe(400);

      for (const method of ['GET', 'PATCH']) {
        const response = await send(app, path, method, 'other', method === 'PATCH' ? { text: 'private' } : undefined);
        expect(response.status).toBe(404);
      }
      expect((await send(app, path + '/sent', 'POST', 'other', { sent: true })).status).toBe(404);

      const publicReport = await send(app, '/api/reports/' + reportId, 'GET', null);
      expect(publicReport.status).toBe(200);
      const publicText = await publicReport.text();
      expect(publicText).not.toContain(editedText);
      expect(publicText).not.toContain('example.invalid/contact');
    }));

  it('records the user-reported sent timestamp idempotently without changing report lifecycle', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await createUser(pool, 'owner');
      const reportId = await createReport(pool, 'owner');
      const app = createApp(pool);
      const path = '/api/reports/' + reportId + '/red-draft';
      await send(app, path, 'POST', 'owner', { locale: 'en' });
      const before = await pool.query<{ status: string; version: number; updated_at: Date }>(
        'SELECT status, version, updated_at FROM reports WHERE id = $1::uuid', [reportId],
      );

      const first = await send(app, path + '/sent', 'POST', 'owner', { sent: true });
      const firstReceipt = RedSentDeclarationSchema.parse(await first.json());
      expect(first.status).toBe(200);
      const draftAfterFirst = RedDraftEnvelopeSchema.parse(
        await (await send(app, path, 'GET', 'owner')).json(),
      ).draft;

      const second = await send(app, path + '/sent', 'POST', 'owner', { sent: true });
      const secondReceipt = RedSentDeclarationSchema.parse(await second.json());
      const after = await pool.query<{ status: string; version: number; updated_at: Date }>(
        'SELECT status, version, updated_at FROM reports WHERE id = $1::uuid', [reportId],
      );

      expect(firstReceipt.sentAt).toBe(secondReceipt.sentAt);
      expect(draftAfterFirst.sentAt).toBe(firstReceipt.sentAt);
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect(after.rows[0]).toMatchObject({ status: 'AWAITING_EXISTENCE', version: 0 });
      expect((await send(app, path + '/sent', 'POST', 'owner', { sent: true, sendNow: true })).status).toBe(400);
    }));

  it('rejects non-RED and demo reports and never creates an external-sending path', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await createUser(pool, 'owner');
      const greenReportId = await createReport(pool, 'owner', { route: 'GREEN' });
      const demoReportId = await createReport(pool, 'owner', { demo: true });
      const app = createApp(pool);

      for (const reportId of [greenReportId, demoReportId]) {
        const response = await send(app, '/api/reports/' + reportId + '/red-draft', 'POST', 'owner', { locale: 'en' });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'NOT_ELIGIBLE' } });
      }
      expect((await send(app, '/api/reports/' + greenReportId + '/red-draft/sent', 'POST', 'owner', { sent: true })).status)
        .toBe(403);
      expect((await send(app, '/api/reports/' + greenReportId + '/red-draft?send=true', 'GET', 'owner')).status)
        .toBe(400);
    }));
});
