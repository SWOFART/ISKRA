import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ViewerReportDetailSchema, VoteReceiptSchema } from '../../../src/shared/contracts';
import { distanceM } from '../../../src/shared/location';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import { ApiError } from '../../../src/worker/middleware/errors';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { apiSecurity } from '../../../src/worker/middleware/security';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import type { ReportMediaResolver } from '../../../src/worker/services/report-context';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const pin = { lat: 49.14, lng: 9.22 };
const reportAuthor = 'vote-report-author';
const reportCleaner = 'vote-report-cleaner';

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
  await pool.query('INSERT INTO users (id, nickname) VALUES ($1::text, $2::varchar)', [id, 'Resident ' + id]);
}

interface ReportOptions {
  readonly status?: 'AWAITING_EXISTENCE' | 'VERIFIED' | 'AWAITING_RESOLUTION' | 'RESOLVED';
  readonly existenceYesCount?: number;
  readonly resolutionYesCount?: number;
  readonly author?: string;
  readonly cleaner?: string;
}

async function createReport(pool: Pool, options: ReportOptions = {}) {
  const id = crypto.randomUUID();
  const analysisId = crypto.randomUUID();
  const author = options.author ?? reportAuthor;
  const status = options.status ?? 'AWAITING_EXISTENCE';
  const existenceYesCount = options.existenceYesCount ?? (status === 'AWAITING_EXISTENCE' ? 0 : 3);
  const resolutionYesCount = options.resolutionYesCount ?? (status === 'RESOLVED' ? 3 : 0);
  const timestamp = new Date().toISOString();

  await pool.query(
    'INSERT INTO ai_analyses (id, owner_user_id, kind, status, input_hash, photo_ids, context, result, expires_at) '
      + "VALUES ($1::uuid, $2::text, 'REPORT', 'READY', $3::varchar, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now() + interval '15 minutes')",
    [analysisId, author, 'vote-report-' + id],
  );
  await pool.query(
    'INSERT INTO reports (id, author_user_id, route, status, description, lat, lng, measured_lat, measured_lng, '
      + 'accuracy_m, captured_location_at, analysis_id, existence_yes_count, resolution_yes_count, '
      + 'existence_verified_at, last_existence_confirmed_at, resolved_at) '
      + 'VALUES ($1::uuid, $2::text, \'GREEN\', $3::report_lifecycle, $4::varchar, $5::double precision, '
      + '$6::double precision, $5::double precision, $6::double precision, 10, $7::timestamptz, $8::uuid, '
      + '$9::integer, $10::integer, CASE WHEN $9 >= 3 THEN $7::timestamptz ELSE NULL END, '
      + 'CASE WHEN $9 >= 1 THEN $7::timestamptz ELSE NULL END, '
      + 'CASE WHEN $3 = \'RESOLVED\' THEN $7::timestamptz ELSE NULL END)',
    [id, author, status, 'Litter near the park.', pin.lat, pin.lng, timestamp, analysisId,
      existenceYesCount, resolutionYesCount],
  );
  await pool.query(
    'INSERT INTO report_photos (owner_user_id, report_id, purpose, state, object_key, ordinal, mime_type, byte_size, sha256, upload_expires_at) '
      + "VALUES ($1::text, $2::uuid, 'REPORT', 'ATTACHED', $3::varchar, 0, 'image/jpeg', 128, $4::char(64), now() + interval '10 minutes')",
    [author, id, 'private/vote-' + id, 'b'.repeat(64)],
  );

  if (status === 'AWAITING_RESOLUTION' || status === 'RESOLVED') {
    const cleaner = options.cleaner ?? reportCleaner;
    const cleanupAnalysisId = crypto.randomUUID();
    await pool.query(
      'INSERT INTO ai_analyses (id, owner_user_id, kind, status, report_id, input_hash, photo_ids, context, result, expires_at) '
        + "VALUES ($1::uuid, $2::text, 'CLEANUP', 'READY', $3::uuid, $4::varchar, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now() + interval '15 minutes')",
      [cleanupAnalysisId, cleaner, id, 'vote-cleanup-' + id],
    );
    const cleanupResult = await pool.query<{ id: string }>(
      'INSERT INTO cleanup_submissions (report_id, cleaner_user_id, analysis_id, status, lat, lng, accuracy_m, captured_location_at, verified_at) '
        + "VALUES ($1::uuid, $2::text, $3::uuid, $4::cleanup_status, $5::double precision, $6::double precision, 10, $7::timestamptz, "
        + 'CASE WHEN $4 = \'VERIFIED\' THEN $7::timestamptz ELSE NULL END) RETURNING id',
      [id, cleaner, cleanupAnalysisId, status === 'RESOLVED' ? 'VERIFIED' : 'AWAITING_VERIFICATION', pin.lat, pin.lng, timestamp],
    );
    await pool.query(
      'INSERT INTO report_photos (owner_user_id, cleanup_id, purpose, state, object_key, ordinal, mime_type, byte_size, sha256, upload_expires_at) '
        + "VALUES ($1::text, $2::uuid, 'CLEANUP', 'ATTACHED', $3::varchar, 0, 'image/jpeg', 128, $4::char(64), now() + interval '10 minutes')",
      [cleaner, cleanupResult.rows[0].id, 'private/vote-after-' + id, 'c'.repeat(64)],
    );
  }

  return { id, author, analysisId };
}

function mediaResolver(): ReportMediaResolver {
  return {
    async resolveAttachedPhotos(photos) {
      return photos.map((photo) => ({
        id: photo.id,
        ordinal: photo.ordinal,
        mediaUrl: 'https://media.invalid/' + photo.id + '?capability=short-lived-test-token',
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
  app.onError((error, context) => {
    if (!(error instanceof ApiError)) console.error('Unexpected voting integration error:', error);
    return handleError(error, context);
  });
  return app;
}

function sendVote(
  app: Hono<WorkerEnv>, actor: string, reportId: string, stage: 'EXISTENCE' | 'RESOLUTION',
  choice: 'YES' | 'NO', key: string, location: { lat: number; lng: number; accuracyM: number; observedAt: string },
) {
  return app.request('/api/reports/' + reportId + '/votes', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + actor,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ stage, choice, location }),
  }, { FIREBASE_PROJECT_ID: 'voting-test-project' });
}

function location(now: number, offsetM = 0, accuracyM = 10) {
  return {
    lat: pin.lat + offsetM / 111_195,
    lng: pin.lng,
    accuracyM,
    observedAt: new Date(now).toISOString(),
  };
}

async function seedReportAward(pool: Pool, userId: string, reportId: string) {
  await pool.query(
    "INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id) VALUES ($1::text, 'REPORT_INITIAL', 5, $2::varchar, $3::uuid)",
    [userId, 'report-initial:' + reportId, reportId],
  );
  await pool.query('UPDATE users SET rp_balance = rp_balance + 5, version = version + 1 WHERE id = $1::text', [userId]);
}

describe('PostgreSQL report voting', () => {
  it('keeps 2 YES plus 1 NO pending and credits each accepted voter once', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all([reportAuthor, 'vote-yes-one', 'vote-yes-two', 'vote-no-one'].map((id) => createUser(pool, id)));
      const report = await createReport(pool);
      const nowValue = Date.now();
      const app = createApp(pool, () => nowValue);
      const actors = [
        ['vote-yes-one', 'YES'], ['vote-yes-two', 'YES'], ['vote-no-one', 'NO'],
      ] as const;

      for (let index = 0; index < actors.length; index++) {
        const [actor, choice] = actors[index];
        const response = await sendVote(app, actor, report.id, 'EXISTENCE', choice, crypto.randomUUID(), location(nowValue));
        expect(response.status).toBe(200);
        expect(VoteReceiptSchema.parse(await response.json())).toMatchObject({
          replayed: false, rpAwarded: 5, balanceVersion: 1,
          report: { id: report.id, status: 'AWAITING_EXISTENCE', version: index + 1 },
        });
      }

      const state = await pool.query<{ status: string; existence_yes_count: number; votes: number; credits: number }>(
        'SELECT r.status, r.existence_yes_count, '
          + '(SELECT count(*)::int FROM votes WHERE report_id = r.id) AS votes, '
          + "(SELECT count(*)::int FROM reward_ledger WHERE report_id = r.id AND kind = 'VOTE') AS credits "
          + 'FROM reports r WHERE r.id = $1::uuid',
        [report.id],
      );
      expect(state.rows[0]).toMatchObject({ status: 'AWAITING_EXISTENCE', existence_yes_count: 2, votes: 3, credits: 3 });
      const balances = await pool.query<{ id: string; rp_balance: number }>(
        'SELECT id, rp_balance FROM users WHERE id = ANY($1::text[]) ORDER BY id',
        [['vote-yes-one', 'vote-yes-two', 'vote-no-one']],
      );
      expect(balances.rows.map((row) => row.rp_balance)).toEqual([5, 5, 5]);
    }));

  it('allows the same eligible resident one vote in each independently open stage', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all([reportAuthor, reportCleaner, 'vote-both-stages'].map((id) => createUser(pool, id)));
      const report = await createReport(pool, { status: 'AWAITING_RESOLUTION', existenceYesCount: 3 });
      const nowValue = Date.now();
      const app = createApp(pool, () => nowValue);
      const existence = await sendVote(app, 'vote-both-stages', report.id, 'EXISTENCE', 'YES', crypto.randomUUID(), location(nowValue));
      const resolution = await sendVote(app, 'vote-both-stages', report.id, 'RESOLUTION', 'NO', crypto.randomUUID(), location(nowValue));

      expect(existence.status).toBe(200);
      expect(resolution.status).toBe(200);
      const receipts = await Promise.all([existence, resolution].map(async (response) => VoteReceiptSchema.parse(await response.json())));
      expect(receipts.map((receipt) => receipt.rpAwarded)).toEqual([5, 5]);
      expect(new Set(receipts.map((receipt) => receipt.voteId)).size).toBe(2);
      expect(receipts.map((receipt) => [receipt.report.version, receipt.balanceVersion])).toEqual([[1, 1], [2, 2]]);
      const balance = await pool.query<{ rp_balance: number }>('SELECT rp_balance FROM users WHERE id = $1::text', ['vote-both-stages']);
      expect(balance.rows[0].rp_balance).toBe(10);
    }));

  it('deduplicates concurrent different keys and replays an old accepted fix before freshness checks', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all([reportAuthor, 'vote-replay', 'vote-stale-new'].map((id) => createUser(pool, id)));
      const report = await createReport(pool);
      let nowValue = Date.now();
      const app = createApp(pool, () => nowValue);
      const original = location(nowValue);
      const firstKey = crypto.randomUUID();
      const secondKey = crypto.randomUUID();
      const responses = await Promise.all([
        sendVote(app, 'vote-replay', report.id, 'EXISTENCE', 'YES', firstKey, original),
        sendVote(app, 'vote-replay', report.id, 'EXISTENCE', 'YES', secondKey, original),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const receipts = await Promise.all(responses.map(async (response) => VoteReceiptSchema.parse(await response.json())));
      expect(new Set(receipts.map((receipt) => receipt.voteId)).size).toBe(1);
      expect(receipts.map((receipt) => receipt.rpAwarded).sort()).toEqual([0, 5]);

      const winningKey = receipts[0].rpAwarded === 5 ? firstKey : secondKey;
      nowValue += 61_000;
      const replay = await sendVote(app, 'vote-replay', report.id, 'EXISTENCE', 'YES', winningKey, original);
      expect(replay.status).toBe(200);
      expect(VoteReceiptSchema.parse(await replay.json())).toMatchObject({ replayed: true, rpAwarded: 0 });

      const staleNewKey = await sendVote(app, 'vote-stale-new', report.id, 'EXISTENCE', 'YES', crypto.randomUUID(), original);
      expect(staleNewKey.status).toBe(422);
      expect(await staleNewKey.json()).toMatchObject({ error: { code: 'LOCATION_STALE' } });
      const conflict = await sendVote(app, 'vote-replay', report.id, 'EXISTENCE', 'NO', winningKey, original);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      const immutableChoice = await sendVote(app, 'vote-replay', report.id, 'EXISTENCE', 'NO', crypto.randomUUID(), location(nowValue));
      expect(immutableChoice.status).toBe(409);
      expect(await immutableChoice.json()).toMatchObject({ error: { code: 'ALREADY_VOTED' } });

      const totals = await pool.query<{ votes: number; awards: number; balance: number }>(
        'SELECT (SELECT count(*)::int FROM votes WHERE report_id = $1::uuid) AS votes, '
          + "(SELECT count(*)::int FROM reward_ledger WHERE report_id = $1::uuid AND kind = 'VOTE') AS awards, "
          + "(SELECT rp_balance FROM users WHERE id = 'vote-replay') AS balance",
        [report.id],
      );
      expect(totals.rows[0]).toEqual({ votes: 1, awards: 1, balance: 5 });
    }));

  it('accepts the exact 150m, 50m accuracy and 60s limits but rejects farther and self votes', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await Promise.all([reportAuthor, 'vote-boundary', 'vote-far'].map((id) => createUser(pool, id)));
      const report = await createReport(pool);
      const nowValue = Date.now();
      const app = createApp(pool, () => nowValue);
      const latitudeDelta = (150 / 6_371_000) * (180 / Math.PI);
      const boundaryLocation = {
        lat: pin.lat + latitudeDelta, lng: pin.lng, accuracyM: 50,
        observedAt: new Date(nowValue - 60_000).toISOString(),
      };
      expect(distanceM(pin, boundaryLocation)).toBeCloseTo(150, 9);
      const boundary = await sendVote(app, 'vote-boundary', report.id, 'EXISTENCE', 'YES', crypto.randomUUID(), boundaryLocation);
      expect(boundary.status).toBe(200);

      const self = await sendVote(app, reportAuthor, report.id, 'EXISTENCE', 'YES', crypto.randomUUID(), location(nowValue));
      expect(self.status).toBe(403);
      expect(await self.json()).toMatchObject({ error: { code: 'SELF_VOTE' } });
      const farLocation = location(nowValue, 151, 10);
      const far = await sendVote(app, 'vote-far', report.id, 'EXISTENCE', 'YES', crypto.randomUUID(), farLocation);
      expect(far.status).toBe(403);
      expect(await far.json()).toMatchObject({ error: { code: 'TOO_FAR' } });
      const tooOld = await sendVote(app, 'vote-far', report.id, 'EXISTENCE', 'YES', crypto.randomUUID(), location(nowValue - 60_001));
      expect(tooOld.status).toBe(422);
      expect(await tooOld.json()).toMatchObject({ error: { code: 'LOCATION_STALE' } });

      const counts = await pool.query<{ votes: number; ledger: number }>(
        'SELECT (SELECT count(*)::int FROM votes WHERE report_id = $1::uuid) AS votes, '
          + 'count(*)::int AS ledger FROM reward_ledger WHERE report_id = $1::uuid',
        [report.id],
      );
      expect(counts.rows[0]).toEqual({ votes: 1, ledger: 1 });
    }));

  it('confirms existence once and resolves cleanup with atomic role awards and notifications', () =>
    withTestDatabase(async (pool) => {
      const actors = [reportAuthor, reportCleaner, 'vote-existence-author', 'vote-final-one', 'vote-final-two', 'vote-final-three'];
      await installSchema(pool);
      await Promise.all(actors.map((id) => createUser(pool, id)));
      const existenceReport = await createReport(pool, {
        existenceYesCount: 2, author: 'vote-existence-author',
      });
      await seedReportAward(pool, 'vote-existence-author', existenceReport.id);
      const resolutionReport = await createReport(pool, {
        status: 'AWAITING_RESOLUTION', existenceYesCount: 3, cleaner: reportCleaner,
      });
      await seedReportAward(pool, reportAuthor, resolutionReport.id);
      let nowValue = Date.now();
      const app = createApp(pool, () => nowValue);

      const existence = await sendVote(app, 'vote-final-one', existenceReport.id, 'EXISTENCE', 'YES', crypto.randomUUID(), location(nowValue));
      expect(existence.status).toBe(200);
      expect(VoteReceiptSchema.parse(await existence.json())).toMatchObject({
        rpAwarded: 5, report: { status: 'VERIFIED', existenceYesCount: 3 },
      });
      const existenceNotifications = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM notifications WHERE report_id = $1::uuid AND kind = 'EXISTENCE_VERIFIED'",
        [existenceReport.id],
      );
      expect(existenceNotifications.rows[0].count).toBe(1);

      const resolutionVoters = ['vote-final-one', 'vote-final-two', 'vote-final-three'];
      let finalResolutionKey = '';
      let finalResolutionLocation = location(nowValue);
      for (let index = 0; index < resolutionVoters.length; index++) {
        nowValue += 1_000;
        const key = crypto.randomUUID();
        const fix = location(nowValue);
        if (index === 2) {
          finalResolutionKey = key;
          finalResolutionLocation = fix;
        }
        const response = await sendVote(app, resolutionVoters[index], resolutionReport.id,
          'RESOLUTION', 'YES', key, fix);
        expect(response.status).toBe(200);
        const receipt = VoteReceiptSchema.parse(await response.json());
        expect(receipt.rpAwarded).toBe(5);
        if (index === 2) expect(receipt.report.status).toBe('RESOLVED');
      }
      nowValue += 61_000;
      const closedStageReplay = await sendVote(app, 'vote-final-three', resolutionReport.id,
        'RESOLUTION', 'YES', finalResolutionKey, finalResolutionLocation);
      expect(closedStageReplay.status).toBe(200);
      expect(VoteReceiptSchema.parse(await closedStageReplay.json())).toMatchObject({
        replayed: true, rpAwarded: 0, report: { status: 'RESOLVED' },
      });

      const state = await pool.query<{
        status: string; resolution_yes_count: number; cleanup_status: string;
        reporter_balance: number; cleaner_balance: number; notifications: number; final_credits: number;
      }>(
        'SELECT r.status, r.resolution_yes_count, cleanup.status AS cleanup_status, '
          + "(SELECT rp_balance FROM users WHERE id = 'vote-report-author') AS reporter_balance, "
          + "(SELECT rp_balance FROM users WHERE id = 'vote-report-cleaner') AS cleaner_balance, "
          + '(SELECT count(*)::int FROM notifications WHERE report_id = r.id) AS notifications, '
          + "(SELECT count(*)::int FROM reward_ledger WHERE report_id = r.id AND kind IN ('REPORT_FINAL', 'CLEANUP')) AS final_credits "
          + 'FROM reports r JOIN cleanup_submissions cleanup ON cleanup.report_id = r.id WHERE r.id = $1::uuid',
        [resolutionReport.id],
      );
      expect(state.rows[0]).toMatchObject({
        status: 'RESOLVED', resolution_yes_count: 3, cleanup_status: 'VERIFIED',
        reporter_balance: 20, cleaner_balance: 40, notifications: 1, final_credits: 2,
      });
      const finalNotification = await pool.query<{ message: string }>(
        "SELECT message FROM notifications WHERE report_id = $1::uuid AND kind = 'REPORT_RESOLVED'",
        [resolutionReport.id],
      );
      expect(finalNotification.rows[0].message).toBe('Your city is cleaner thanks to you!');
    }));

  it('pays a self-cleaning reporter 60 RP only on resolution with separate role references and canonical versions', () =>
    withTestDatabase(async (pool) => {
      const selfCleaner = 'vote-self-cleaner';
      const voters = ['vote-self-one', 'vote-self-two', 'vote-self-three'];
      await installSchema(pool);
      await Promise.all([selfCleaner, ...voters].map((id) => createUser(pool, id)));
      const report = await createReport(pool, {
        status: 'AWAITING_RESOLUTION', existenceYesCount: 3,
        author: selfCleaner, cleaner: selfCleaner,
      });
      await seedReportAward(pool, selfCleaner, report.id);
      let nowValue = Date.now();
      const app = createApp(pool, () => nowValue);

      const selfVote = await sendVote(app, selfCleaner, report.id, 'RESOLUTION', 'YES', crypto.randomUUID(), location(nowValue));
      expect(selfVote.status).toBe(403);
      expect(await selfVote.json()).toMatchObject({ error: { code: 'SELF_VOTE' } });

      for (let index = 0; index < 2; index++) {
        nowValue += 1_000;
        const response = await sendVote(app, voters[index], report.id, 'RESOLUTION', 'YES', crypto.randomUUID(), location(nowValue));
        expect(response.status).toBe(200);
        const receipt = VoteReceiptSchema.parse(await response.json());
        expect(receipt).toMatchObject({
          rpAwarded: 5, balanceVersion: 1,
          report: { status: 'AWAITING_RESOLUTION', resolutionYesCount: index + 1, version: index + 1 },
        });
      }

      const beforeResolution = await pool.query<{ rp_balance: number; version: number; finalCredits: number }>(
        'SELECT u.rp_balance, u.version, '
          + "(SELECT count(*)::int FROM reward_ledger WHERE report_id = $2::uuid AND kind IN ('REPORT_FINAL', 'CLEANUP')) AS \"finalCredits\" "
          + 'FROM users u WHERE u.id = $1::text',
        [selfCleaner, report.id],
      );
      expect(beforeResolution.rows[0]).toEqual({ rp_balance: 5, version: 1, finalCredits: 0 });

      nowValue += 1_000;
      const finalVote = await sendVote(app, voters[2], report.id, 'RESOLUTION', 'YES', crypto.randomUUID(), location(nowValue));
      expect(finalVote.status).toBe(200);
      expect(VoteReceiptSchema.parse(await finalVote.json())).toMatchObject({
        replayed: false, rpAwarded: 5, balance: 5, balanceVersion: 1,
        report: { status: 'RESOLVED', resolutionYesCount: 3, version: 3 },
      });

      const roleLedger = await pool.query<{ kind: string; delta: number; source_ref: string }>(
        'SELECT kind, delta, source_ref FROM reward_ledger WHERE user_id = $1::text AND report_id = $2::uuid ORDER BY kind',
        [selfCleaner, report.id],
      );
      expect(roleLedger.rows.map(({ kind, delta }) => [kind, delta])).toEqual([
        ['REPORT_INITIAL', 5], ['REPORT_FINAL', 15], ['CLEANUP', 40],
      ]);
      expect(new Set(roleLedger.rows.map((row) => row.source_ref)).size).toBe(3);
      const state = await pool.query<{ rp_balance: number; account_version: number; report_version: number; cleanup_status: string; cleanup_version: number }>(
        'SELECT u.rp_balance, u.version AS account_version, r.version AS report_version, '
          + 'cleanup.status AS cleanup_status, cleanup.version AS cleanup_version '
          + 'FROM users u JOIN reports r ON r.author_user_id = u.id '
          + 'JOIN cleanup_submissions cleanup ON cleanup.report_id = r.id WHERE u.id = $1::text AND r.id = $2::uuid',
        [selfCleaner, report.id],
      );
      expect(state.rows[0]).toEqual({
        rp_balance: 60, account_version: 2, report_version: 3, cleanup_status: 'VERIFIED', cleanup_version: 1,
      });
    }));

  it('allows a reporter to resolve a different cleaner and returns canonical role/account versions', () =>
    withTestDatabase(async (pool) => {
      const reporter = 'vote-reporter-verifier';
      const cleaner = 'vote-another-cleaner';
      const otherVoters = ['vote-reporter-prior-one', 'vote-reporter-prior-two'];
      await installSchema(pool);
      await Promise.all([reporter, cleaner, ...otherVoters].map((id) => createUser(pool, id)));
      const report = await createReport(pool, {
        status: 'AWAITING_RESOLUTION', existenceYesCount: 3,
        author: reporter, cleaner,
      });
      await seedReportAward(pool, reporter, report.id);
      let nowValue = Date.now();
      const app = createApp(pool, () => nowValue);

      for (const actor of otherVoters) {
        nowValue += 1_000;
        const response = await sendVote(app, actor, report.id, 'RESOLUTION', 'YES', crypto.randomUUID(), location(nowValue));
        expect(response.status).toBe(200);
      }
      const key = crypto.randomUUID();
      nowValue += 1_000;
      const fix = location(nowValue);
      const finalVote = await sendVote(app, reporter, report.id, 'RESOLUTION', 'YES', key, fix);
      expect(finalVote.status).toBe(200);
      expect(VoteReceiptSchema.parse(await finalVote.json())).toMatchObject({
        rpAwarded: 5, balance: 25, balanceVersion: 2,
        report: { status: 'RESOLVED', resolutionYesCount: 3, version: 3 },
      });

      const reporterLedger = await pool.query<{ kind: string; delta: number; source_ref: string }>(
        'SELECT kind, delta, source_ref FROM reward_ledger WHERE user_id = $1::text AND report_id = $2::uuid ORDER BY kind',
        [reporter, report.id],
      );
      expect(reporterLedger.rows.map(({ kind, delta }) => [kind, delta])).toEqual([
        ['REPORT_INITIAL', 5], ['REPORT_FINAL', 15], ['VOTE', 5],
      ]);
      expect(new Set(reporterLedger.rows.map((row) => row.source_ref)).size).toBe(3);
      const accountVersions = await pool.query<{ reporter_balance: number; reporter_version: number; cleaner_balance: number; cleaner_version: number }>(
        'SELECT (SELECT rp_balance FROM users WHERE id = $1::text) AS reporter_balance, '
          + '(SELECT version FROM users WHERE id = $1::text) AS reporter_version, '
          + '(SELECT rp_balance FROM users WHERE id = $2::text) AS cleaner_balance, '
          + '(SELECT version FROM users WHERE id = $2::text) AS cleaner_version',
        [reporter, cleaner],
      );
      expect(accountVersions.rows[0]).toEqual({
        reporter_balance: 25, reporter_version: 2, cleaner_balance: 40, cleaner_version: 1,
      });

      nowValue += 61_000;
      const replay = await sendVote(app, reporter, report.id, 'RESOLUTION', 'YES', key, fix);
      expect(replay.status).toBe(200);
      expect(VoteReceiptSchema.parse(await replay.json())).toMatchObject({
        replayed: true, rpAwarded: 0, balance: 25, balanceVersion: 2,
        report: { status: 'RESOLVED', version: 3 },
      });
    }));

  it('serializes competing threshold votes so existence gets count four and resolution closes once', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const actors = [reportAuthor, reportCleaner, 'vote-race-one', 'vote-race-two', 'vote-race-three', 'vote-race-four'];
      await Promise.all(actors.map((id) => createUser(pool, id)));
      const existenceReport = await createReport(pool, { existenceYesCount: 2 });
      const resolutionReport = await createReport(pool, {
        status: 'AWAITING_RESOLUTION', existenceYesCount: 3, resolutionYesCount: 2, cleaner: reportCleaner,
      });
      await seedReportAward(pool, reportAuthor, resolutionReport.id);
      for (const actor of ['vote-race-three', 'vote-race-four']) {
        const vote = await pool.query<{ id: string }>(
          "INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m) VALUES ($1::uuid, 'RESOLUTION', $2::text, 'YES', 10, 10) RETURNING id",
          [resolutionReport.id, actor],
        );
        await pool.query(
          "INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id, vote_id) VALUES ($1::text, 'VOTE', 5, $2::varchar, $3::uuid, $4::uuid)",
          [actor, 'vote:' + vote.rows[0].id, resolutionReport.id, vote.rows[0].id],
        );
        await pool.query('UPDATE users SET rp_balance = rp_balance + 5 WHERE id = $1::text', [actor]);
      }
      let nowValue = Date.now();
      const app = createApp(pool, () => nowValue);
      const existenceResponses = await Promise.all(['vote-race-one', 'vote-race-two'].map((actor) =>
        sendVote(app, actor, existenceReport.id, 'EXISTENCE', 'YES', crypto.randomUUID(), location(nowValue))));
      expect(existenceResponses.map((response) => response.status)).toEqual([200, 200]);
      const existenceState = await pool.query<{ status: string; yes: number; notifications: number }>(
        'SELECT status, existence_yes_count AS yes, '
          + "(SELECT count(*)::int FROM notifications WHERE report_id = reports.id AND kind = 'EXISTENCE_VERIFIED') AS notifications "
          + 'FROM reports WHERE id = $1::uuid',
        [existenceReport.id],
      );
      expect(existenceState.rows[0]).toEqual({ status: 'VERIFIED', yes: 4, notifications: 1 });

      nowValue += 1_000;
      const resolutionResponses = await Promise.all(['vote-race-one', 'vote-race-two'].map((actor) =>
        sendVote(app, actor, resolutionReport.id, 'RESOLUTION', 'YES', crypto.randomUUID(), location(nowValue))));
      expect(resolutionResponses.map((response) => response.status).sort()).toEqual([200, 409]);
      const closedResponse = resolutionResponses.find((response) => response.status === 409);
      expect(await closedResponse?.json()).toMatchObject({ error: { code: 'STAGE_CLOSED' } });
      const resolutionState = await pool.query<{ status: string; yes: number; finalCredits: number; notifications: number }>(
        'SELECT status, resolution_yes_count AS yes, '
          + "(SELECT count(*)::int FROM reward_ledger WHERE report_id = reports.id AND kind IN ('REPORT_FINAL', 'CLEANUP')) AS \"finalCredits\", "
          + "(SELECT count(*)::int FROM notifications WHERE report_id = reports.id AND kind = 'REPORT_RESOLVED') AS notifications "
          + 'FROM reports WHERE id = $1::uuid',
        [resolutionReport.id],
      );
      expect(resolutionState.rows[0]).toEqual({ status: 'RESOLVED', yes: 3, finalCredits: 2, notifications: 1 });
    }));

  it('accepts fourth-through-eighth existence support without repeating threshold effects or cleanup transition', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const supportVoters = Array.from({ length: 5 }, (_, index) => `vote-support-${index + 4}`);
      const priorVoters = ['vote-support-1', 'vote-support-2', 'vote-support-3'];
      await Promise.all([reportAuthor, reportCleaner, 'vote-after-support', 'vote-support-nine-no', ...priorVoters, ...supportVoters]
        .map((id) => createUser(pool, id)));
      const report = await createReport(pool, {
        status: 'AWAITING_RESOLUTION', existenceYesCount: 3, resolutionYesCount: 0, cleaner: reportCleaner,
      });
      await seedReportAward(pool, reportAuthor, report.id);
      for (const actor of priorVoters) {
        const vote = await pool.query<{ id: string }>(
          "INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m) VALUES ($1::uuid, 'EXISTENCE', $2::text, 'YES', 10, 10) RETURNING id",
          [report.id, actor],
        );
        await pool.query(
          "INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id, vote_id) VALUES ($1::text, 'VOTE', 5, $2::varchar, $3::uuid, $4::uuid)",
          [actor, 'vote:' + vote.rows[0].id, report.id, vote.rows[0].id],
        );
        await pool.query('UPDATE users SET rp_balance = rp_balance + 5 WHERE id = $1::text', [actor]);
      }
      await pool.query(
        "INSERT INTO notifications (user_id, report_id, kind, message) VALUES ($1::text, $2::uuid, 'EXISTENCE_VERIFIED', 'Residents confirmed your report.')",
        [reportAuthor, report.id],
      );

      let nowValue = Date.now();
      const app = createApp(pool, () => nowValue);
      const before = await pool.query<{ last_existence_confirmed_at: Date; version: number }>(
        'SELECT last_existence_confirmed_at, version FROM reports WHERE id = $1::uuid', [report.id],
      );
      const fourthKey = crypto.randomUUID();
      const fourthFix = location(nowValue);
      const fourth = await sendVote(app, supportVoters[0], report.id, 'EXISTENCE', 'YES', fourthKey, fourthFix);
      expect(fourth.status).toBe(200);
      expect(VoteReceiptSchema.parse(await fourth.json())).toMatchObject({
        replayed: false, rpAwarded: 5, balance: 5, balanceVersion: 1,
        report: { status: 'AWAITING_RESOLUTION', existenceYesCount: 4, resolutionYesCount: 0, version: 1 },
      });

      let eighthKey = '';
      let eighthFix = location(nowValue);
      for (let index = 1; index < supportVoters.length; index++) {
        nowValue += 1_000;
        const key = crypto.randomUUID();
        const fix = location(nowValue);
        if (index === supportVoters.length - 1) { eighthKey = key; eighthFix = fix; }
        const response = await sendVote(app, supportVoters[index], report.id, 'EXISTENCE', 'YES', key, fix);
        expect(response.status).toBe(200);
        expect(VoteReceiptSchema.parse(await response.json())).toMatchObject({
          replayed: false, rpAwarded: 5, balance: 5, balanceVersion: 1,
          report: {
            status: 'AWAITING_RESOLUTION', existenceYesCount: index + 4,
            resolutionYesCount: 0, version: index + 1,
          },
        });
      }

      const detailResponse = await app.request(`/api/reports/${report.id}`, {
        headers: { Authorization: 'Bearer vote-after-support' },
      }, { FIREBASE_PROJECT_ID: 'voting-test-project' });
      expect(detailResponse.status).toBe(200);
      const detail = ViewerReportDetailSchema.parse(await detailResponse.json());
      expect(detail).toMatchObject({
        status: 'AWAITING_RESOLUTION', existenceYesCount: 8, resolutionYesCount: 0,
        openVoteStages: ['EXISTENCE', 'RESOLUTION'],
        viewer: {
          canSubmitCleanup: false,
          stages: { EXISTENCE: { canVote: true }, RESOLUTION: { canVote: true } },
        },
      });

      const afterEighthYes = await pool.query<{ last_existence_confirmed_at: Date }>(
        'SELECT last_existence_confirmed_at FROM reports WHERE id = $1::uuid', [report.id],
      );
      nowValue += 1_000;
      const noKey = crypto.randomUUID();
      const noFix = location(nowValue);
      const noResponse = await sendVote(app, 'vote-support-nine-no', report.id, 'EXISTENCE', 'NO', noKey, noFix);
      expect(noResponse.status).toBe(200);
      expect(VoteReceiptSchema.parse(await noResponse.json())).toMatchObject({
        replayed: false, rpAwarded: 5, balance: 5, balanceVersion: 1,
        report: { status: 'AWAITING_RESOLUTION', existenceYesCount: 8, resolutionYesCount: 0, version: 6 },
      });

      nowValue += 61_000;
      const fourthReplay = await sendVote(app, supportVoters[0], report.id, 'EXISTENCE', 'YES', fourthKey, fourthFix);
      expect(fourthReplay.status).toBe(200);
      expect(VoteReceiptSchema.parse(await fourthReplay.json())).toMatchObject({
        replayed: true, rpAwarded: 0, balance: 5, balanceVersion: 1,
        report: { status: 'AWAITING_RESOLUTION', existenceYesCount: 8, version: 6 },
      });
      const eighthSemanticReplay = await sendVote(
        app, supportVoters[4], report.id, 'EXISTENCE', 'YES', crypto.randomUUID(), eighthFix,
      );
      expect(eighthSemanticReplay.status).toBe(200);
      expect(VoteReceiptSchema.parse(await eighthSemanticReplay.json())).toMatchObject({
        replayed: true, rpAwarded: 0, balance: 5, balanceVersion: 1,
        report: { status: 'AWAITING_RESOLUTION', existenceYesCount: 8, version: 6 },
      });
      const noReplay = await sendVote(app, 'vote-support-nine-no', report.id, 'EXISTENCE', 'NO', noKey, noFix);
      expect(noReplay.status).toBe(200);
      expect(VoteReceiptSchema.parse(await noReplay.json())).toMatchObject({
        replayed: true, rpAwarded: 0, balance: 5, balanceVersion: 1,
        report: { status: 'AWAITING_RESOLUTION', existenceYesCount: 8, version: 6 },
      });

      const state = await pool.query<{
        status: string; existence_yes_count: number; resolution_yes_count: number; version: number;
        last_existence_confirmed_at: Date; cleanup_status: string; existence_notifications: number;
        resolution_notifications: number; voter_balance: number; voter_version: number;
        vote_rows: number; vote_credits: number;
      }>(
        `SELECT r.status, r.existence_yes_count, r.resolution_yes_count, r.version, r.last_existence_confirmed_at,
           cleanup.status AS cleanup_status,
           (SELECT count(*)::int FROM notifications WHERE report_id = r.id AND kind = 'EXISTENCE_VERIFIED') AS existence_notifications,
           (SELECT count(*)::int FROM notifications WHERE report_id = r.id AND kind = 'REPORT_RESOLVED') AS resolution_notifications,
           (SELECT rp_balance FROM users WHERE id = $2::text) AS voter_balance,
           (SELECT version FROM users WHERE id = $2::text) AS voter_version,
           (SELECT count(*)::int FROM votes WHERE report_id = r.id AND stage = 'EXISTENCE') AS vote_rows,
           (SELECT count(*)::int FROM reward_ledger WHERE report_id = r.id AND kind = 'VOTE') AS vote_credits
         FROM reports r JOIN cleanup_submissions cleanup ON cleanup.report_id = r.id WHERE r.id = $1::uuid`,
        [report.id, supportVoters[0]],
      );
      expect(state.rows[0]).toEqual({
        status: 'AWAITING_RESOLUTION', existence_yes_count: 8, resolution_yes_count: 0, version: 6,
        last_existence_confirmed_at: expect.any(Date), cleanup_status: 'AWAITING_VERIFICATION',
        existence_notifications: 1, resolution_notifications: 0,
        voter_balance: 5, voter_version: 1, vote_rows: 9, vote_credits: 9,
      });
      expect(state.rows[0].last_existence_confirmed_at.getTime())
        .toBeGreaterThan(before.rows[0].last_existence_confirmed_at.getTime());
      expect(state.rows[0].last_existence_confirmed_at.getTime())
        .toBe(afterEighthYes.rows[0].last_existence_confirmed_at.getTime());
    }));

  it('keeps existence support open in VERIFIED without repeating verification effects', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const priorVoters = ['vote-verified-prior-1', 'vote-verified-prior-2', 'vote-verified-prior-3'];
      const supportVoters = Array.from({ length: 5 }, (_, index) => `vote-verified-support-${index + 4}`);
      await Promise.all([reportAuthor, 'vote-verified-observer', ...priorVoters, ...supportVoters]
        .map((id) => createUser(pool, id)));
      const report = await createReport(pool, { status: 'VERIFIED', existenceYesCount: 3 });
      await seedReportAward(pool, reportAuthor, report.id);
      for (const actor of priorVoters) {
        const vote = await pool.query<{ id: string }>(
          "INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m) VALUES ($1::uuid, 'EXISTENCE', $2::text, 'YES', 10, 10) RETURNING id",
          [report.id, actor],
        );
        await pool.query(
          "INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id, vote_id) VALUES ($1::text, 'VOTE', 5, $2::varchar, $3::uuid, $4::uuid)",
          [actor, 'vote:' + vote.rows[0].id, report.id, vote.rows[0].id],
        );
        await pool.query('UPDATE users SET rp_balance = rp_balance + 5 WHERE id = $1::text', [actor]);
      }
      await pool.query(
        "INSERT INTO notifications (user_id, report_id, kind, message) VALUES ($1::text, $2::uuid, 'EXISTENCE_VERIFIED', 'Residents confirmed your report.')",
        [reportAuthor, report.id],
      );

      let nowValue = Date.now();
      const app = createApp(pool, () => nowValue);
      const before = await pool.query<{ existence_verified_at: Date; last_existence_confirmed_at: Date }>(
        'SELECT existence_verified_at, last_existence_confirmed_at FROM reports WHERE id = $1::uuid', [report.id],
      );
      for (let index = 0; index < supportVoters.length; index++) {
        nowValue += 1_000;
        const response = await sendVote(
          app, supportVoters[index], report.id, 'EXISTENCE', 'YES', crypto.randomUUID(), location(nowValue),
        );
        expect(response.status).toBe(200);
        expect(VoteReceiptSchema.parse(await response.json())).toMatchObject({
          replayed: false, rpAwarded: 5, balanceVersion: 1,
          report: { status: 'VERIFIED', existenceYesCount: index + 4, version: index + 1 },
        });
      }
      const prematureResolution = await sendVote(
        app, 'vote-verified-observer', report.id, 'RESOLUTION', 'YES', crypto.randomUUID(), location(nowValue),
      );
      expect(prematureResolution.status).toBe(409);
      expect(await prematureResolution.json()).toMatchObject({ error: { code: 'STAGE_CLOSED' } });

      const detailResponse = await app.request(`/api/reports/${report.id}`, {
        headers: { Authorization: 'Bearer vote-verified-observer' },
      }, { FIREBASE_PROJECT_ID: 'voting-test-project' });
      expect(detailResponse.status).toBe(200);
      expect(ViewerReportDetailSchema.parse(await detailResponse.json())).toMatchObject({
        status: 'VERIFIED', existenceYesCount: 8, openVoteStages: ['EXISTENCE'],
        viewer: { stages: { EXISTENCE: { canVote: true }, RESOLUTION: { canVote: false, reason: 'STAGE_CLOSED' } } },
      });

      const state = await pool.query<{
        status: string; existence_yes_count: number; verified_at: Date; last_confirmed_at: Date;
        notifications: number; votes: number; credits: number;
      }>(
        `SELECT status, existence_yes_count, existence_verified_at AS verified_at,
           last_existence_confirmed_at AS last_confirmed_at,
           (SELECT count(*)::int FROM notifications WHERE report_id = reports.id AND kind = 'EXISTENCE_VERIFIED') AS notifications,
           (SELECT count(*)::int FROM votes WHERE report_id = reports.id AND stage = 'EXISTENCE') AS votes,
           (SELECT count(*)::int FROM reward_ledger WHERE report_id = reports.id AND kind = 'VOTE') AS credits
         FROM reports WHERE id = $1::uuid`,
        [report.id],
      );
      expect(state.rows[0]).toMatchObject({
        status: 'VERIFIED', existence_yes_count: 8,
        verified_at: before.rows[0].existence_verified_at,
        notifications: 1, votes: 8, credits: 8,
      });
      expect(state.rows[0].last_confirmed_at.getTime())
        .toBeGreaterThan(before.rows[0].last_existence_confirmed_at.getTime());
    }));

  it('closes both vote stages after resolution while an accepted vote still replays safely', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const resolutionVoters = ['vote-close-one', 'vote-close-two', 'vote-close-three'];
      const priorExistenceVoters = ['vote-close-existence-one', 'vote-close-existence-two', 'vote-close-existence-three'];
      const afterClose = 'vote-after-resolution';
      await Promise.all([reportAuthor, reportCleaner, ...priorExistenceVoters, ...resolutionVoters, afterClose]
        .map((id) => createUser(pool, id)));
      const report = await createReport(pool, {
        status: 'AWAITING_RESOLUTION', existenceYesCount: 3, resolutionYesCount: 0, cleaner: reportCleaner,
      });
      await seedReportAward(pool, reportAuthor, report.id);
      for (const actor of priorExistenceVoters) {
        const vote = await pool.query<{ id: string }>(
          "INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m) VALUES ($1::uuid, 'EXISTENCE', $2::text, 'YES', 10, 10) RETURNING id",
          [report.id, actor],
        );
        await pool.query(
          "INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id, vote_id) VALUES ($1::text, 'VOTE', 5, $2::varchar, $3::uuid, $4::uuid)",
          [actor, 'vote:' + vote.rows[0].id, report.id, vote.rows[0].id],
        );
        await pool.query('UPDATE users SET rp_balance = rp_balance + 5 WHERE id = $1::text', [actor]);
      }
      let nowValue = Date.now();
      const app = createApp(pool, () => nowValue);
      const finalKey = crypto.randomUUID();
      let finalFix = location(nowValue);

      const preResolutionDetail = await app.request(`/api/reports/${report.id}`, {
        headers: { Authorization: `Bearer ${afterClose}` },
      }, { FIREBASE_PROJECT_ID: 'voting-test-project' });
      expect(preResolutionDetail.status).toBe(200);
      expect(ViewerReportDetailSchema.parse(await preResolutionDetail.json()).viewer.stages).toMatchObject({
        EXISTENCE: { canVote: true }, RESOLUTION: { canVote: true },
      });

      for (let index = 0; index < resolutionVoters.length; index++) {
        if (index > 0) nowValue += 1_000;
        const actor = resolutionVoters[index];
        const key = index === resolutionVoters.length - 1 ? finalKey : crypto.randomUUID();
        const fix = location(nowValue);
        if (index === resolutionVoters.length - 1) finalFix = fix;
        const response = await sendVote(app, actor, report.id, 'RESOLUTION', 'YES', key, fix);
        expect(response.status).toBe(200);
      }

      const newExistence = await sendVote(
        app, afterClose, report.id, 'EXISTENCE', 'YES', crypto.randomUUID(), location(nowValue),
      );
      const newResolution = await sendVote(
        app, afterClose, report.id, 'RESOLUTION', 'YES', crypto.randomUUID(), location(nowValue),
      );
      for (const response of [newExistence, newResolution]) {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'STAGE_CLOSED' } });
      }

      nowValue += 61_000;
      const replay = await sendVote(app, resolutionVoters[2], report.id, 'RESOLUTION', 'YES', finalKey, finalFix);
      expect(replay.status).toBe(200);
      expect(VoteReceiptSchema.parse(await replay.json())).toMatchObject({
        replayed: true, rpAwarded: 0, report: { status: 'RESOLVED', resolutionYesCount: 3 },
      });

      const detailResponse = await app.request(`/api/reports/${report.id}`, {
        headers: { Authorization: `Bearer ${afterClose}` },
      }, { FIREBASE_PROJECT_ID: 'voting-test-project' });
      const detail = ViewerReportDetailSchema.parse(await detailResponse.json());
      expect(detail).toMatchObject({
        status: 'RESOLVED', openVoteStages: [],
        viewer: {
          stages: {
            EXISTENCE: { canVote: false, reason: 'STAGE_CLOSED' },
            RESOLUTION: { canVote: false, reason: 'STAGE_CLOSED' },
          },
        },
      });
      const state = await pool.query<{ existence_votes: number; resolution_votes: number; support_balance: number; support_credits: number }>(
        `SELECT (SELECT count(*)::int FROM votes WHERE report_id = $1::uuid AND stage = 'EXISTENCE') AS existence_votes,
           (SELECT count(*)::int FROM votes WHERE report_id = $1::uuid AND stage = 'RESOLUTION') AS resolution_votes,
           (SELECT rp_balance FROM users WHERE id = $2::text) AS support_balance,
           (SELECT count(*)::int FROM reward_ledger WHERE report_id = $1::uuid AND user_id = $2::text AND kind = 'VOTE') AS support_credits`,
        [report.id, afterClose],
      );
      expect(state.rows[0]).toEqual({ existence_votes: 3, resolution_votes: 3, support_balance: 0, support_credits: 0 });
    }));
});
