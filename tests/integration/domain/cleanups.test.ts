import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { CleanupReceiptSchema } from '../../../src/shared/contracts';
import { distanceM } from '../../../src/shared/location';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { apiSecurity } from '../../../src/worker/middleware/security';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import type { ReportMediaResolver } from '../../../src/worker/services/report-context';
import { hashBeforeEvidence } from '../../../src/worker/services/report-context';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const pin = { lat: 49.14, lng: 9.22 };

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
  await pool.query('INSERT INTO users (id, nickname) VALUES ($1::text, $2::varchar)', [id, `Resident ${id}`]);
}

interface ReportOptions {
  readonly route?: 'GREEN' | 'YELLOW' | 'RED';
  readonly status?: 'AWAITING_EXISTENCE' | 'VERIFIED';
  readonly beforePhotoCount?: number;
  readonly isDemo?: boolean;
}

async function createReport(pool: Pool, author: string, options: ReportOptions = {}) {
  const route = options.route ?? 'GREEN';
  const status = options.status ?? 'VERIFIED';
  const analysis = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses (owner_user_id, kind, status, input_hash, photo_ids, context, result, expires_at)
     VALUES ($1::text, 'REPORT', 'READY', $2::varchar, '[]'::jsonb, '{}'::jsonb,
       '{"decision":"ACCEPT"}'::jsonb, now() + interval '15 minutes') RETURNING id`,
    [author, `report-${crypto.randomUUID()}`],
  );
  const reportResult = await pool.query<{ id: string }>(
    `INSERT INTO reports (
       author_user_id, route, status, description, lat, lng, measured_lat, measured_lng,
       accuracy_m, captured_location_at, analysis_id, existence_yes_count,
       existence_verified_at, last_existence_confirmed_at, is_demo
     ) VALUES ($1::text, $2::report_route, $3::report_lifecycle, 'Litter near the park.',
       $4::double precision, $5::double precision, $4::double precision, $5::double precision,
       10, now(), $6::uuid, $7::integer,
       CASE WHEN $3 = 'VERIFIED' THEN now() ELSE NULL END,
       CASE WHEN $7 > 0 THEN now() ELSE NULL END, $8::boolean)
     RETURNING id`,
    [author, route, status, pin.lat, pin.lng, analysis.rows[0].id,
      status === 'VERIFIED' ? 3 : 0, options.isDemo ?? false],
  );
  const reportId = reportResult.rows[0].id;
  const beforePhotos: { id: string; ordinal: number; sha256: string }[] = [];
  for (let ordinal = 0; ordinal < (options.beforePhotoCount ?? 1); ordinal++) {
    const sha256 = String.fromCharCode(97 + ordinal).repeat(64);
    const photo = await pool.query<{ id: string }>(
      `INSERT INTO report_photos (
         owner_user_id, report_id, purpose, state, object_key, ordinal, mime_type, byte_size,
         sha256, upload_expires_at
       ) VALUES ($1::text, $2::uuid, 'REPORT', 'ATTACHED', $3::varchar, $4::smallint,
         'image/jpeg', 128, $5::char(64), now() + interval '15 minutes') RETURNING id`,
      [author, reportId, `private/before/${crypto.randomUUID()}`, ordinal, sha256],
    );
    beforePhotos.push({ id: photo.rows[0].id, ordinal, sha256 });
  }
  return { id: reportId, author, beforePhotos };
}

interface CandidateOptions {
  readonly owner?: string;
  readonly result?: unknown;
  readonly beforeEvidenceHash?: string;
  readonly expiresAt?: string;
  readonly photoCount?: number;
  readonly locationAgeMs?: number;
  readonly locationOffsetM?: number;
}

async function createCandidate(
  pool: Pool,
  report: Awaited<ReturnType<typeof createReport>>,
  options: CandidateOptions = {},
) {
  const owner = options.owner ?? 'cleanup-resident';
  const photoIds: string[] = [];
  for (let ordinal = 0; ordinal < (options.photoCount ?? 1); ordinal++) {
    const photo = await pool.query<{ id: string }>(
      `INSERT INTO report_photos (
         owner_user_id, purpose, state, object_key, ordinal, mime_type, byte_size, sha256, upload_expires_at
       ) VALUES ($1::text, 'CLEANUP', 'UPLOADED', $2::varchar, $3::smallint, 'image/jpeg', 128,
         $4::char(64), now() + interval '5 minutes') RETURNING id`,
      [owner, `private/after/${crypto.randomUUID()}`, ordinal, String.fromCharCode(107 + ordinal).repeat(64)],
    );
    photoIds.push(photo.rows[0].id);
  }
  const location = {
    lat: pin.lat + ((options.locationOffsetM ?? 20) / 6_371_000) * (180 / Math.PI),
    lng: pin.lng, accuracyM: 10,
    observedAt: new Date(Date.now() - (options.locationAgeMs ?? 0)).toISOString(),
  };
  const beforeEvidenceHash = options.beforeEvidenceHash ?? await hashBeforeEvidence(report.beforePhotos);
  const context = {
    reportId: report.id,
    location,
    beforeEvidenceHash,
    reportContext: {
      reportId: report.id, route: 'GREEN', status: 'VERIFIED',
      beforePhotoIds: report.beforePhotos.map((photo) => photo.id), beforeEvidenceHash,
    },
  };
  const analysis = await pool.query<{ id: string; input_hash: string }>(
    `INSERT INTO ai_analyses (
       owner_user_id, kind, status, report_id, input_hash, photo_ids, context, result, expires_at
     ) VALUES ($1::text, 'CLEANUP', 'READY', $2::uuid, $3::varchar, $4::jsonb, $5::jsonb, $6::jsonb,
       COALESCE($7::timestamptz, now() + interval '15 minutes')) RETURNING id, input_hash`,
    [owner, report.id, `cleanup-${crypto.randomUUID()}`, JSON.stringify(photoIds), JSON.stringify(context),
      JSON.stringify(options.result ?? {
        decision: 'ACCEPT', sameScene: 'LIKELY', appearsClean: true, hazardRemaining: false,
        reason: 'The same area appears clear.', confidence: 0.9,
      }), options.expiresAt ?? null],
  );
  await pool.query(
    `INSERT INTO analysis_leases (owner_user_id, kind, input_hash, current_analysis_id, lease_until)
     VALUES ($1::text, 'CLEANUP', $2::varchar, $3::uuid, now() + interval '15 minutes')`,
    [owner, analysis.rows[0].input_hash, analysis.rows[0].id],
  );
  return { owner, id: analysis.rows[0].id, photoIds, location };
}

function mediaResolver(): ReportMediaResolver {
  return {
    async resolveAttachedPhotos(photos) {
      return photos.map((photo) => ({
        id: photo.id, ordinal: photo.ordinal,
        mediaUrl: `https://media.invalid/${photo.id}?capability=temporary-test-token`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }));
    },
  };
}

function createApp(pool: Pool, now: () => number) {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.route('/api', createDomainRoutes({
    database: new PostgresTransactionDatabase(pool),
    reportMedia: mediaResolver(),
    verify: async (token) => ({ uid: token }),
    now,
  }));
  app.onError(handleError);
  return app;
}

function sendCleanup(
  app: Hono<WorkerEnv>, actor: string, reportId: string, analysisId: string, key = crypto.randomUUID(),
) {
  return app.request(`/api/reports/${reportId}/cleanups`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${actor}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ analysisId }),
  }, { FIREBASE_PROJECT_ID: 'cleanup-test-project' });
}

function sendSupportVote(app: Hono<WorkerEnv>, actor: string, reportId: string, now: number) {
  return app.request(`/api/reports/${reportId}/votes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${actor}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      stage: 'EXISTENCE', choice: 'YES',
      location: { ...pin, accuracyM: 10, observedAt: new Date(now).toISOString() },
    }),
  }, { FIREBASE_PROJECT_ID: 'cleanup-test-project' });
}

describe('PostgreSQL cleanup submission', () => {
  it('accepts the reporter as cleaner once, attaches after photos, and awards no early RP', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const reporter = 'cleanup-self-reporter';
      await createUser(pool, reporter);
      const report = await createReport(pool, reporter, { beforePhotoCount: 2 });
      const candidate = await createCandidate(pool, report, { owner: reporter, photoCount: 2 });
      const app = createApp(pool, () => Date.now());
      const preSubmit = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM cleanup_submissions WHERE report_id = $1::uuid', [report.id],
      );
      expect(preSubmit.rows[0].count).toBe(0); // local intent/analysis has not reserved the report

      const key = crypto.randomUUID();
      const response = await sendCleanup(app, reporter, report.id, candidate.id, key);
      expect(response.status).toBe(201);
      const receipt = CleanupReceiptSchema.parse(await response.json());
      expect(receipt).toMatchObject({
        status: 'AWAITING_VERIFICATION', provisionalRp: 40,
        report: {
          id: report.id, status: 'AWAITING_RESOLUTION', resolutionYesCount: 0, version: 1,
          cleaner: { id: reporter }, viewer: { canSubmitCleanup: false },
          afterPhotos: candidate.photoIds.map((id, index) => ({ id, ordinal: index + 1 })),
        },
      });

      const effects = await pool.query<{
        rp_balance: number; user_version: number; report_version: number; analysis_consumed: boolean;
        cleanup_rows: number; attached: number; cleanup_credits: number;
      }>(
        `SELECT u.rp_balance, u.version AS user_version, r.version AS report_version,
           a.consumed_at IS NOT NULL AS analysis_consumed,
           (SELECT count(*)::int FROM cleanup_submissions WHERE report_id = r.id) AS cleanup_rows,
           (SELECT count(*)::int FROM report_photos WHERE cleanup_id = receipt.id AND state = 'ATTACHED') AS attached,
           (SELECT count(*)::int FROM reward_ledger WHERE report_id = r.id AND kind = 'CLEANUP') AS cleanup_credits
         FROM cleanup_submissions receipt
         JOIN reports r ON r.id = receipt.report_id
         JOIN users u ON u.id = receipt.cleaner_user_id
         JOIN ai_analyses a ON a.id = receipt.analysis_id
         WHERE receipt.report_id = $1::uuid`,
        [report.id],
      );
      expect(effects.rows[0]).toEqual({
        rp_balance: 0, user_version: 0, report_version: 1, analysis_consumed: true,
        cleanup_rows: 1, attached: 2, cleanup_credits: 0,
      });
      const photos = await pool.query<{ state: string; cleanup_id: string | null }>(
        'SELECT state, cleanup_id FROM report_photos WHERE id = ANY($1::uuid[]) ORDER BY ordinal',
        [candidate.photoIds],
      );
      expect(photos.rows).toEqual(candidate.photoIds.map(() => ({
        state: 'ATTACHED', cleanup_id: receipt.cleanupId,
      })));

      const replay = await sendCleanup(app, reporter, report.id, candidate.id, key);
      expect(replay.status).toBe(201);
      expect(CleanupReceiptSchema.parse(await replay.json())).toMatchObject({
        cleanupId: receipt.cleanupId, provisionalRp: 40,
        report: { id: report.id, status: 'AWAITING_RESOLUTION', version: 1 },
      });
      const replacement = await sendCleanup(app, reporter, report.id, candidate.id);
      expect(replacement.status).toBe(409);
      expect(await replacement.json()).toMatchObject({ error: { code: 'CLEANUP_ALREADY_SUBMITTED' } });
    }));

  it('lets two residents analyze without reservations but only one concurrent valid submission wins', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const reporter = 'cleanup-race-reporter';
      const cleaners = ['cleanup-race-one', 'cleanup-race-two'];
      await Promise.all([reporter, ...cleaners].map((id) => createUser(pool, id)));
      const report = await createReport(pool, reporter);
      const candidates = await Promise.all(cleaners.map((owner) => createCandidate(pool, report, { owner })));
      const before = await pool.query<{ cleanups: number; uploads: number }>(
        `SELECT (SELECT count(*)::int FROM cleanup_submissions WHERE report_id = $1::uuid) AS cleanups,
           (SELECT count(*)::int FROM report_photos WHERE id = ANY($2::uuid[]) AND state = 'UPLOADED') AS uploads`,
        [report.id, candidates.flatMap((candidate) => candidate.photoIds)],
      );
      expect(before.rows[0]).toEqual({ cleanups: 0, uploads: 2 });

      const app = createApp(pool, () => Date.now());
      const responses = await Promise.all(candidates.map((candidate) =>
        sendCleanup(app, candidate.owner, report.id, candidate.id)));
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const winnerResponse = responses.find((response) => response.status === 201)!;
      const winner = CleanupReceiptSchema.parse(await winnerResponse.json());
      const loserResponse = responses.find((response) => response.status === 409)!;
      expect(await loserResponse.json()).toMatchObject({ error: { code: 'CLEANUP_ALREADY_SUBMITTED' } });

      const state = await pool.query<{ cleaner_user_id: string; cleanup_count: number; attached_count: number; credits: number }>(
        `SELECT cleanup.cleaner_user_id,
           (SELECT count(*)::int FROM cleanup_submissions WHERE report_id = cleanup.report_id) AS cleanup_count,
           (SELECT count(*)::int FROM report_photos WHERE cleanup_id = cleanup.id AND state = 'ATTACHED') AS attached_count,
           (SELECT count(*)::int FROM reward_ledger WHERE report_id = cleanup.report_id AND kind = 'CLEANUP') AS credits
         FROM cleanup_submissions cleanup WHERE cleanup.report_id = $1::uuid`,
        [report.id],
      );
      expect(cleaners).toContain(state.rows[0].cleaner_user_id);
      expect(state.rows[0]).toMatchObject({ cleanup_count: 1, attached_count: 1, credits: 0 });
      const winnerCandidate = candidates.find((candidate) => candidate.owner === state.rows[0].cleaner_user_id)!;
      const loserCandidate = candidates.find((candidate) => candidate.owner !== winnerCandidate.owner)!;
      expect(winner.report.cleaner?.id).toBe(winnerCandidate.owner);
      const loserEvidence = await pool.query<{ state: string; cleanup_id: string | null; consumed_at: Date | null }>(
        `SELECT photo.state, photo.cleanup_id, analysis.consumed_at
         FROM report_photos photo CROSS JOIN ai_analyses analysis
         WHERE photo.id = ANY($1::uuid[]) AND analysis.id = $2::uuid ORDER BY photo.ordinal`,
        [loserCandidate.photoIds, loserCandidate.id],
      );
      expect(loserEvidence.rows).toEqual(loserCandidate.photoIds.map(() => ({
        state: 'UPLOADED', cleanup_id: null, consumed_at: null,
      })));
    }));

  it('allows cleanup analysis bound to immutable before evidence after support changes report.version', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const reporter = 'cleanup-support-reporter';
      const supporter = 'cleanup-support-voter';
      const cleaner = 'cleanup-support-cleaner';
      await Promise.all([reporter, supporter, cleaner].map((id) => createUser(pool, id)));
      const report = await createReport(pool, reporter);
      const candidate = await createCandidate(pool, report, {
        owner: cleaner, locationOffsetM: 150, locationAgeMs: 5 * 60_000,
      });
      expect(distanceM(pin, candidate.location)).toBeCloseTo(150, 9);
      let now = Date.now();
      const app = createApp(pool, () => now);

      const support = await sendSupportVote(app, supporter, report.id, now);
      expect(support.status).toBe(200);
      const beforeSubmission = await pool.query<{ status: string; existence_yes_count: number; version: number }>(
        'SELECT status, existence_yes_count, version FROM reports WHERE id = $1::uuid', [report.id],
      );
      expect(beforeSubmission.rows[0]).toMatchObject({ status: 'VERIFIED', existence_yes_count: 4, version: 1 });

      now += 1_000;
      const response = await sendCleanup(app, cleaner, report.id, candidate.id);
      expect(response.status).toBe(201);
      expect(CleanupReceiptSchema.parse(await response.json())).toMatchObject({
        report: { id: report.id, status: 'AWAITING_RESOLUTION', existenceYesCount: 4, version: 2 },
      });
    }));

  it('denies wrong report route/state, RETAKE analysis, and changed before evidence without partial effects', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const reporter = 'cleanup-invalid-reporter';
      const cleaner = 'cleanup-invalid-cleaner';
      await Promise.all([reporter, cleaner].map((id) => createUser(pool, id)));
      const app = createApp(pool, () => Date.now());

      const wrongRoute = await createReport(pool, reporter, { route: 'YELLOW' });
      const wrongRouteAnalysis = await createCandidate(pool, wrongRoute, { owner: cleaner });
      const routeResponse = await sendCleanup(app, cleaner, wrongRoute.id, wrongRouteAnalysis.id);
      expect(routeResponse.status).toBe(403);
      expect(await routeResponse.json()).toMatchObject({ error: { code: 'NOT_ELIGIBLE' } });

      const wrongState = await createReport(pool, reporter, { status: 'AWAITING_EXISTENCE' });
      const wrongStateAnalysis = await createCandidate(pool, wrongState, { owner: cleaner });
      const stateResponse = await sendCleanup(app, cleaner, wrongState.id, wrongStateAnalysis.id);
      expect(stateResponse.status).toBe(409);
      expect(await stateResponse.json()).toMatchObject({ error: { code: 'STAGE_CLOSED' } });

      const retakeReport = await createReport(pool, reporter);
      const retake = await createCandidate(pool, retakeReport, {
        owner: cleaner,
        result: {
          decision: 'RETAKE', reasonCode: 'LITTER_REMAINING',
          reason: 'Litter remains visible.', instruction: 'Finish cleaning safely, then capture again.',
        },
      });
      const retakeResponse = await sendCleanup(app, cleaner, retakeReport.id, retake.id);
      expect(retakeResponse.status).toBe(422);
      expect(await retakeResponse.json()).toMatchObject({ error: { code: 'AI_REJECTED' } });

      const changedEvidenceReport = await createReport(pool, reporter);
      const changedEvidence = await createCandidate(pool, changedEvidenceReport, {
        owner: cleaner, beforeEvidenceHash: 'f'.repeat(64),
      });
      const changedResponse = await sendCleanup(app, cleaner, changedEvidenceReport.id, changedEvidence.id);
      expect(changedResponse.status).toBe(409);
      expect(await changedResponse.json()).toMatchObject({ error: { code: 'ANALYSIS_CONSUMED' } });

      const untouched = await pool.query<{ cleanups: number; attached: number; consumed: number }>(
        `SELECT (SELECT count(*)::int FROM cleanup_submissions) AS cleanups,
           (SELECT count(*)::int FROM report_photos WHERE state = 'ATTACHED' AND purpose = 'CLEANUP') AS attached,
           (SELECT count(*)::int FROM ai_analyses WHERE kind = 'CLEANUP' AND consumed_at IS NOT NULL) AS consumed`,
      );
      expect(untouched.rows[0]).toEqual({ cleanups: 0, attached: 0, consumed: 0 });
    }));
});
