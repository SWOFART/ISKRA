import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  PublicReportDetailSchema,
  ReportListSchema,
  ViewerReportDetailSchema,
} from '../../../src/shared/contracts';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { apiSecurity } from '../../../src/worker/middleware/security';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import type { AttachedPhotoReference, ReportMediaResolver } from '../../../src/worker/services/report-context';
import { PostgresReportContextReader } from '../../../src/worker/services/report-context';
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

async function createUser(pool: Pool, id: string, nickname = id) {
  await pool.query('INSERT INTO users (id, nickname) VALUES ($1, $2)', [id, nickname]);
}

type ReportOptions = {
  route?: 'GREEN' | 'YELLOW' | 'RED';
  status?: 'AWAITING_EXISTENCE' | 'VERIFIED' | 'AWAITING_RESOLUTION' | 'RESOLVED';
  existenceCount?: number;
  resolutionCount?: number;
  cleaner?: string;
  beforePhotoCount?: number;
  afterPhotoCount?: number;
};

async function createReport(pool: Pool, author: string, options: ReportOptions = {}) {
  const route = options.route ?? 'GREEN';
  const status = options.status ?? 'AWAITING_EXISTENCE';
  const existenceCount = options.existenceCount ?? 0;
  const resolutionCount = options.resolutionCount ?? 0;
  const analysis = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses (owner_user_id, kind, status, input_hash, result, expires_at)
     VALUES ($1, 'REPORT', 'READY', $2, '{"decision":"ACCEPT"}'::jsonb, now() + interval '15 minutes')
     RETURNING id`, [author, `report-${crypto.randomUUID()}`],
  );
  const report = await pool.query<{ id: string }>(
    `INSERT INTO reports (
       author_user_id, route, status, description, lat, lng, measured_lat, measured_lng,
       accuracy_m, captured_location_at, analysis_id, existence_yes_count,
       resolution_yes_count, existence_verified_at, last_existence_confirmed_at, resolved_at
     ) VALUES (
       $1, $2::report_route, $3::report_lifecycle, 'Public report description', 49.14, 9.22,
       49.14, 9.22, 10, now(), $4::uuid, $5, $6,
       CASE WHEN $5 >= 3 THEN now() - interval '2 minutes' ELSE NULL END,
       CASE WHEN $5 > 0 THEN now() - interval '1 minute' ELSE NULL END,
       CASE WHEN $3 = 'RESOLVED' THEN now() ELSE NULL END
     ) RETURNING id`,
    [author, route, status, analysis.rows[0].id, existenceCount, resolutionCount],
  );
  const reportId = report.rows[0].id;
  const beforePhotoIds: string[] = [];
  for (let ordinal = 0; ordinal < (options.beforePhotoCount ?? 1); ordinal++) {
    const photo = await pool.query<{ id: string }>(
      `INSERT INTO report_photos (
         owner_user_id, report_id, purpose, state, object_key, ordinal, mime_type, byte_size,
         sha256, upload_expires_at
       ) VALUES ($1, $2::uuid, 'REPORT', 'ATTACHED', $3, $4, 'image/jpeg', 128, $5, now() + interval '5 minutes')
       RETURNING id`,
      [author, reportId, `private-object-key/${crypto.randomUUID()}`, ordinal, 'a'.repeat(64)],
    );
    beforePhotoIds.push(photo.rows[0].id);
  }

  if (options.cleaner) {
    const cleanupAnalysis = await pool.query<{ id: string }>(
      `INSERT INTO ai_analyses (owner_user_id, kind, status, report_id, input_hash, result, expires_at)
       VALUES ($1, 'CLEANUP', 'READY', $2::uuid, $3, '{"decision":"ACCEPT"}'::jsonb,
         now() + interval '15 minutes') RETURNING id`,
      [options.cleaner, reportId, `cleanup-${crypto.randomUUID()}`],
    );
    const cleanup = await pool.query<{ id: string }>(
      `INSERT INTO cleanup_submissions (
         report_id, cleaner_user_id, analysis_id, status, lat, lng, accuracy_m,
         captured_location_at, verified_at
       ) VALUES ($1::uuid, $2, $3::uuid, $4::cleanup_status, 49.14, 9.22, 10, now(),
         CASE WHEN $4 = 'VERIFIED' THEN now() ELSE NULL END) RETURNING id`,
      [reportId, options.cleaner, cleanupAnalysis.rows[0].id,
        status === 'RESOLVED' ? 'VERIFIED' : 'AWAITING_VERIFICATION'],
    );
    for (let ordinal = 0; ordinal < (options.afterPhotoCount ?? 1); ordinal++) {
      await pool.query(
        `INSERT INTO report_photos (
           owner_user_id, cleanup_id, purpose, state, object_key, ordinal, mime_type, byte_size,
           sha256, upload_expires_at
         ) VALUES ($1, $2::uuid, 'CLEANUP', 'ATTACHED', $3, $4, 'image/jpeg', 128, $5,
           now() + interval '5 minutes')`,
        [options.cleaner, cleanup.rows[0].id, `private-cleanup-key/${crypto.randomUUID()}`,
          ordinal, 'b'.repeat(64)],
      );
    }
  }
  return { id: reportId, beforePhotoIds };
}

function createMediaResolver(): ReportMediaResolver & { calls: AttachedPhotoReference[][] } {
  const calls: AttachedPhotoReference[][] = [];
  return {
    calls,
    async resolveAttachedPhotos(photos) {
      calls.push([...photos]);
      return photos.map(({ id, ordinal }) => ({
        id,
        ordinal,
        mediaUrl: `https://media.invalid/content/${id}?capability=temporary-test-token`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }));
    },
  };
}

function createApp(pool: Pool, media: ReportMediaResolver) {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.route('/api', createDomainRoutes({
    database: new PostgresTransactionDatabase(pool), reportMedia: media,
    verify: async (token) => ({ uid: token }),
  }));
  app.onError(handleError);
  return app;
}

describe('PostgreSQL report read projections', () => {
  it('applies citywide pending filters by the viewer stage and exposes only public projections', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all(['viewer', 'resolution-only-viewer', 'author-open', 'cleaner', 'author-cleanup', 'author-verified']
        .map((id) => createUser(pool, id, `Public ${id}`)));
      const selfPending = await createReport(pool, 'viewer');
      const openPending = await createReport(pool, 'author-open');
      const cleanupPending = await createReport(pool, 'author-cleanup', {
        status: 'AWAITING_RESOLUTION', existenceCount: 4, resolutionCount: 1,
        cleaner: 'cleaner', beforePhotoCount: 2, afterPhotoCount: 2,
      });
      const confirmed = await createReport(pool, 'author-verified', {
        status: 'VERIFIED', existenceCount: 4,
      });
      await pool.query(
        `INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m)
         VALUES ($1::uuid, 'EXISTENCE', 'viewer', 'NO', 100, 20)`, [cleanupPending.id],
      );
      await pool.query(
        `INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m)
         VALUES ($1::uuid, 'RESOLUTION', 'resolution-only-viewer', 'NO', 100, 20)`, [cleanupPending.id],
      );

      const media = createMediaResolver();
      const app = createApp(pool, media);
      const environment = { FIREBASE_PROJECT_ID: 'test-project' };
      const pendingResponse = await app.request('/api/reports?city=heilbronn&needsVerification=true', {
        headers: { Authorization: 'Bearer viewer' },
      }, environment);
      expect(pendingResponse.status).toBe(200);
      const pending = ReportListSchema.parse(await pendingResponse.json());
      const pendingIds = new Set(pending.items.map((item) => item.id));
      expect(pendingIds).toContain(openPending.id);
      expect(pendingIds).toContain(cleanupPending.id); // existence vote does not hide resolution
      expect(pendingIds).not.toContain(selfPending.id);
      expect(pendingIds).not.toContain(confirmed.id);
      expect(pending.items.every((item) => item.status !== 'RESOLVED')).toBe(true);

      const priorResolution = await app.request('/api/reports?needsVerification=true', {
        headers: { Authorization: 'Bearer resolution-only-viewer' },
      }, environment);
      expect(new Set(ReportListSchema.parse(await priorResolution.json()).items.map((item) => item.id)))
        .toContain(cleanupPending.id); // prior resolution vote does not hide continued existence support

      await pool.query(
        `INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m)
         VALUES ($1::uuid, 'RESOLUTION', 'viewer', 'YES', 100, 20)`, [cleanupPending.id],
      );
      const afterBothVotes = await app.request('/api/reports?needsVerification=true', {
        headers: { Authorization: 'Bearer viewer' },
      }, environment);
      const afterIds = new Set(ReportListSchema.parse(await afterBothVotes.json()).items.map((item) => item.id));
      expect(afterIds).not.toContain(cleanupPending.id);

      const ordinaryList = await app.request('/api/reports', {}, environment);
      const summaries = ReportListSchema.parse(await ordinaryList.json()).items;
      const confirmedSummary = summaries.find((item) => item.id === confirmed.id);
      expect(confirmedSummary).toMatchObject({
        existenceYesCount: 4,
        existenceVerifiedAt: expect.any(String),
        lastExistenceConfirmedAt: expect.any(String),
      });
      expect(ordinaryList.headers.get('cache-control')).toContain('no-store');
      const authenticatedList = await app.request('/api/reports?route=GREEN', {
        headers: { Authorization: 'Bearer viewer' },
      }, environment);
      expect(authenticatedList.status).toBe(200);
      expect(ReportListSchema.parse(await authenticatedList.json()).items.length).toBeGreaterThan(0);

      const detailResponse = await app.request(`/api/reports/${confirmed.id}`, {}, environment);
      expect(detailResponse.status).toBe(200);
      const detail = PublicReportDetailSchema.parse(await detailResponse.json());
      expect(detail).toMatchObject({
        openVoteStages: ['EXISTENCE'],
        currentStage: 'EXISTENCE',
        existenceYesCount: 4,
        author: { id: 'author-verified', nickname: 'Public author-verified' },
      });
      expect('viewer' in detail).toBe(false);
      expect(JSON.stringify(detail)).not.toMatch(/private-object-key|email|balance|choice|rp_balance/i);
      expect(media.calls.at(-1)).toEqual([
        { id: confirmed.beforePhotoIds[0], ordinal: 1, purpose: 'REPORT' },
      ]);

      const unsupportedCity = await app.request('/api/reports?city=stuttgart', {}, environment);
      expect(unsupportedCity.status).toBe(400);
      const unknownFilter = await app.request('/api/reports?viewport=49.14,9.22', {}, environment);
      expect(unknownFilter.status).toBe(400);
    }));

  it('returns stage-specific viewer hints without vote choices and resolves all attached galleries', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all(['viewer', 'reporter', 'cleaner'].map((id) => createUser(pool, id)));
      const target = await createReport(pool, 'reporter', {
        status: 'AWAITING_RESOLUTION', existenceCount: 4, resolutionCount: 1,
        cleaner: 'cleaner', beforePhotoCount: 2, afterPhotoCount: 3,
      });
      await pool.query(
        `INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m)
         VALUES ($1::uuid, 'EXISTENCE', 'viewer', 'NO', 100, 20)`, [target.id],
      );
      const media = createMediaResolver();
      const app = createApp(pool, media);
      const environment = { FIREBASE_PROJECT_ID: 'test-project' };
      const response = await app.request(`/api/reports/${target.id}`, {
        headers: { Authorization: 'Bearer viewer' },
      }, environment);
      expect(response.status).toBe(200);
      const detail = ViewerReportDetailSchema.parse(await response.json());
      expect(detail).toMatchObject({
        currentStage: 'RESOLUTION',
        openVoteStages: ['EXISTENCE', 'RESOLUTION'],
        viewer: {
          stages: {
            EXISTENCE: { canVote: false, hasVoted: true, reason: 'ALREADY_VOTED' },
            RESOLUTION: { canVote: true, hasVoted: false, reason: null },
          },
          canSubmitCleanup: false,
        },
      });
      expect(detail.beforePhotos).toHaveLength(2);
      expect(detail.afterPhotos).toHaveLength(3);
      expect(JSON.stringify(detail)).not.toMatch(/"choice"|"balance"|"rp_balance"|private-cleanup-key/i);

      const reporterResponse = await app.request(`/api/reports/${target.id}`, {
        headers: { Authorization: 'Bearer reporter' },
      }, environment);
      const reporterDetail = ViewerReportDetailSchema.parse(await reporterResponse.json());
      expect(reporterDetail.viewer.stages.EXISTENCE).toMatchObject({
        canVote: false, reason: 'SELF_VOTE', hasVoted: false,
      });

      const cleanerResponse = await app.request(`/api/reports/${target.id}`, {
        headers: { Authorization: 'Bearer cleaner' },
      }, environment);
      const cleanerDetail = ViewerReportDetailSchema.parse(await cleanerResponse.json());
      expect(cleanerDetail.viewer.stages.RESOLUTION).toMatchObject({
        canVote: false, reason: 'SELF_VOTE', hasVoted: false,
      });
      expect(media.calls[0]).toHaveLength(5);
      expect(media.calls[0].map(({ purpose }) => purpose)).toEqual([
        'REPORT', 'REPORT', 'CLEANUP', 'CLEANUP', 'CLEANUP',
      ]);
    }));

  it('paginates by immutable publication order and provides cleanup context only for verified GREEN reports', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all(['author-one', 'author-two', 'author-three'].map((id) => createUser(pool, id)));
      const first = await createReport(pool, 'author-one', { beforePhotoCount: 2 });
      const second = await createReport(pool, 'author-two');
      const third = await createReport(pool, 'author-three');
      const context = new PostgresReportContextReader(new PostgresTransactionDatabase(pool));
      const verified = await createReport(pool, 'author-one', { status: 'VERIFIED', existenceCount: 3 });

      const resolvedContext = await context.getForCleanupAnalysis(verified.id);
      expect(resolvedContext).toMatchObject({
        reportId: verified.id,
        route: 'GREEN',
        status: 'VERIFIED',
        beforePhotoIds: verified.beforePhotoIds,
        reportLocation: { lat: 49.14, lng: 9.22 },
      });
      expect(resolvedContext?.beforeEvidenceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await context.getForCleanupAnalysis(first.id)).toBeNull();

      const app = createApp(pool, createMediaResolver());
      const environment = { FIREBASE_PROJECT_ID: 'test-project' };
      const pageOneResponse = await app.request('/api/reports?limit=1', {}, environment);
      const pageOne = ReportListSchema.parse(await pageOneResponse.json());
      expect(pageOne.items).toHaveLength(1);
      expect(pageOne.nextCursor).not.toBeNull();
      const pageTwoResponse = await app.request(
        `/api/reports?limit=1&cursor=${encodeURIComponent(pageOne.nextCursor!)}`, {}, environment,
      );
      const pageTwo = ReportListSchema.parse(await pageTwoResponse.json());
      expect(pageTwo.items).toHaveLength(1);
      expect(pageTwo.items[0].id).not.toBe(pageOne.items[0].id);
      expect([first.id, second.id, third.id, verified.id]).toContain(pageOne.items[0].id);
    }));
});
