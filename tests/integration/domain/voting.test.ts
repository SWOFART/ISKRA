import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { VoteReceiptSchema } from '../../../src/shared/contracts';
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
    await pool.query(
      'INSERT INTO cleanup_submissions (report_id, cleaner_user_id, analysis_id, status, lat, lng, accuracy_m, captured_location_at, verified_at) '
        + "VALUES ($1::uuid, $2::text, $3::uuid, $4::cleanup_status, $5::double precision, $6::double precision, 10, $7::timestamptz, "
        + 'CASE WHEN $4 = \'VERIFIED\' THEN $7::timestamptz ELSE NULL END)',
      [id, cleaner, cleanupAnalysisId, status === 'RESOLVED' ? 'VERIFIED' : 'AWAITING_VERIFICATION', pin.lat, pin.lng, timestamp],
    );
    await pool.query(
      'INSERT INTO report_photos (owner_user_id, cleanup_id, purpose, state, object_key, ordinal, mime_type, byte_size, sha256, upload_expires_at) '
        + "VALUES ($1::text, $2::uuid, 'CLEANUP', 'ATTACHED', $3::varchar, 0, 'image/jpeg', 128, $4::char(64), now() + interval '10 minutes')",
      [cleaner, id, 'private/vote-after-' + id, 'c'.repeat(64)],
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

      for (const [actor, choice] of actors) {
        const response = await sendVote(app, actor, report.id, 'EXISTENCE', choice, crypto.randomUUID(), location(nowValue));
        expect(response.status).toBe(200);
        expect(VoteReceiptSchema.parse(await response.json())).toMatchObject({
          replayed: false, rpAwarded: 5, report: { id: report.id, status: 'AWAITING_EXISTENCE' },
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
      const boundaryLocation = location(nowValue - 60_000, 149.99, 50);
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
});
