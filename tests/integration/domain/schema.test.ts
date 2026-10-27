import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');

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

async function createUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, nickname) VALUES ($1::text, $1::text)', [id]);
}

async function createAnalysis(
  pool: Pool,
  owner: string,
  inputHash: string,
  status: 'RUNNING' | 'READY' | 'FAILED' = 'READY',
  reportId: string | null = null,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses (owner_user_id, kind, status, report_id, input_hash, result, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb,
       CASE WHEN $3::analysis_status = 'READY' THEN now() + interval '30 minutes' ELSE NULL END)
     RETURNING id`,
    [owner, reportId === null ? 'REPORT' : 'CLEANUP', status, reportId, inputHash,
      status === 'READY' ? JSON.stringify({ decision: 'ACCEPT' }) : null],
  );
  return result.rows[0].id;
}

async function createReport(
  pool: Pool,
  owner: string,
  analysisId: string,
  options: { status?: string; existenceCount?: number; resolutionCount?: number } = {},
): Promise<string> {
  const status = options.status ?? 'AWAITING_EXISTENCE';
  const existenceCount = options.existenceCount ?? 0;
  const resolutionCount = options.resolutionCount ?? 0;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO reports (
       author_user_id, route, status, description, lat, lng, measured_lat, measured_lng,
       accuracy_m, captured_location_at, analysis_id, existence_yes_count,
       resolution_yes_count, existence_verified_at, last_existence_confirmed_at, resolved_at
     ) VALUES (
       $1, 'GREEN', $2, 'A schema integration test report', 49.14, 9.22, 49.14, 9.22,
       10, now(), $3, $4, $5,
       CASE WHEN $4 >= 3 THEN now() - interval '1 minute' ELSE NULL END,
       CASE WHEN $4 > 0 THEN now() ELSE NULL END,
       CASE WHEN $5 = 3 THEN now() ELSE NULL END
     ) RETURNING id`,
    [owner, status, analysisId, existenceCount, resolutionCount],
  );
  return result.rows[0].id;
}

async function createCleanupAnalysis(pool: Pool, owner: string, reportId: string, hash: string): Promise<string> {
  return createAnalysis(pool, owner, hash, 'READY', reportId);
}

describe('P0 PostgreSQL schema migration', () => {
  it('allows continued existence support while resolution votes remain capped at three', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const owner = 'schema-count-owner';
      await createUser(pool, owner);

      for (const resolutionCount of [0, 1, 2, 3]) {
        const analysisId = await createAnalysis(pool, owner, `report-${resolutionCount}`);
        const status = resolutionCount === 3 ? 'RESOLVED' : 'AWAITING_RESOLUTION';
        const reportId = await createReport(pool, owner, analysisId, {
          status, existenceCount: 4, resolutionCount,
        });
        const row = await pool.query<{
          existence_yes_count: number;
          resolution_yes_count: number;
          reporter_total_rp: number;
          initial_rp: number;
          cleaner_rp: number;
          version: number;
        }>(
          `SELECT existence_yes_count, resolution_yes_count, reporter_total_rp, initial_rp,
             cleaner_rp, version FROM reports WHERE id = $1`, [reportId],
        );
        expect(row.rows[0]).toMatchObject({
          existence_yes_count: 4, resolution_yes_count: resolutionCount,
          reporter_total_rp: 20, initial_rp: 5, cleaner_rp: 40, version: 0,
        });
      }

      const account = await pool.query<{ rp_balance: number; version: number }>(
        'SELECT rp_balance, version FROM users WHERE id = $1', [owner],
      );
      expect(account.rows[0]).toEqual({ rp_balance: 0, version: 0 });

      const invalidAnalysis = await createAnalysis(pool, owner, 'report-resolution-overflow');
      await expect(createReport(pool, owner, invalidAnalysis, {
        status: 'AWAITING_RESOLUTION', existenceCount: 4, resolutionCount: 4,
      })).rejects.toMatchObject({ code: '23514' });
    }));

  it('rejects duplicate vote, ledger credit, accepted cleanup, photo parent slot and report analysis', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const author = 'schema-parent-author';
      const cleaner = 'schema-parent-cleaner';
      const voter = 'schema-parent-voter';
      const otherAuthor = 'schema-parent-other-author';
      await Promise.all([
        createUser(pool, author), createUser(pool, cleaner), createUser(pool, voter), createUser(pool, otherAuthor),
      ]);

      const reportAnalysis = await createAnalysis(pool, author, 'report-parent');
      const reportId = await createReport(pool, author, reportAnalysis, {
        status: 'VERIFIED', existenceCount: 3,
      });
      await expect(createReport(pool, author, reportAnalysis)).rejects.toMatchObject({ code: '23505' });
      const anotherResidentAnalysis = await createAnalysis(pool, otherAuthor, 'report-wrong-owner');
      await expect(createReport(pool, author, anotherResidentAnalysis)).rejects.toMatchObject({ code: '23503' });

      const vote = await pool.query<{ id: string }>(
        `INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m)
         VALUES ($1, 'EXISTENCE', $2, 'YES', 100, 20) RETURNING id`, [reportId, voter],
      );
      await expect(pool.query(
        `INSERT INTO votes (report_id, stage, voter_user_id, choice, distance_m, accuracy_m)
         VALUES ($1, 'EXISTENCE', $2, 'NO', 100, 20)`, [reportId, voter],
      )).rejects.toMatchObject({ code: '23505' });

      await pool.query(
        `INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id, vote_id)
         VALUES ($1, 'VOTE', 5, $2, $3, $4)`, [voter, `vote:${vote.rows[0].id}`, reportId, vote.rows[0].id],
      );
      await expect(pool.query(
        `INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id, vote_id)
         VALUES ($1, 'VOTE', 5, $2, $3, $4)`, [voter, `vote:${vote.rows[0].id}`, reportId, vote.rows[0].id],
      )).rejects.toMatchObject({ code: '23505' });

      const cleanupAnalysis = await createCleanupAnalysis(pool, cleaner, reportId, 'cleanup-parent');
      const cleanup = await pool.query<{ id: string }>(
        `INSERT INTO cleanup_submissions (
           report_id, cleaner_user_id, analysis_id, lat, lng, accuracy_m, captured_location_at
         ) VALUES ($1, $2, $3, 49.14, 9.22, 10, now()) RETURNING id`,
        [reportId, cleaner, cleanupAnalysis],
      );
      const otherCleanupAnalysis = await createCleanupAnalysis(pool, cleaner, reportId, 'cleanup-parent-2');
      await expect(pool.query(
        `INSERT INTO cleanup_submissions (
           report_id, cleaner_user_id, analysis_id, lat, lng, accuracy_m, captured_location_at
         ) VALUES ($1, $2, $3, 49.14, 9.22, 10, now())`,
        [reportId, cleaner, otherCleanupAnalysis],
      )).rejects.toMatchObject({ code: '23505' });

      const photoFields = [author, reportId, 'schema/photo-0', 0, 'a'.repeat(64)];
      await pool.query(
        `INSERT INTO report_photos (
           owner_user_id, report_id, purpose, state, object_key, ordinal, mime_type,
           byte_size, sha256, upload_expires_at
         ) VALUES ($1, $2, 'REPORT', 'ATTACHED', $3, $4, 'image/jpeg', 128, $5, now() + interval '5 minutes')`,
        photoFields,
      );
      await expect(pool.query(
        `INSERT INTO report_photos (
           owner_user_id, report_id, purpose, state, object_key, ordinal, mime_type,
           byte_size, sha256, upload_expires_at
         ) VALUES ($1, $2, 'REPORT', 'ATTACHED', 'schema/photo-duplicate-slot', $3, 'image/jpeg', 128, $4,
           now() + interval '5 minutes')`, [author, reportId, 0, 'b'.repeat(64)],
      )).rejects.toMatchObject({ code: '23505' });
      await expect(pool.query(
        `INSERT INTO report_photos (
           owner_user_id, cleanup_id, purpose, state, object_key, ordinal, mime_type,
           byte_size, sha256, upload_expires_at
         ) VALUES ($1, $2, 'REPORT', 'ATTACHED', 'schema/photo-wrong-parent', 0, 'image/jpeg', 128, $3,
           now() + interval '5 minutes')`, [author, cleanup.rows[0].id, 'c'.repeat(64)],
      )).rejects.toMatchObject({ code: '23514' });

      const wrongParentReportAnalysis = await createAnalysis(pool, author, 'wrong-cleanup-parent-report');
      const wrongParentReport = await createReport(pool, author, wrongParentReportAnalysis, {
        status: 'VERIFIED', existenceCount: 3,
      });
      const wrongParentAnalysis = await createCleanupAnalysis(pool, cleaner, wrongParentReport, 'cleanup-parent-3');
      await expect(pool.query(
        `INSERT INTO cleanup_submissions (
           report_id, cleaner_user_id, analysis_id, lat, lng, accuracy_m, captured_location_at
         ) VALUES ($1, $2, $3, 49.14, 9.22, 10, now())`,
        [wrongParentReport, author, wrongParentAnalysis],
      )).rejects.toMatchObject({ code: '23503' });
      expect(cleanup.rows[0].id).toBeTruthy();
    }));

  it('allows a fresh analysis attempt for the same input hash and moves its lease slot', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      const owner = 'schema-attempt-owner';
      await createUser(pool, owner);
      const hash = 'same-input-hash-after-expiry';
      const failedAttempt = await createAnalysis(pool, owner, hash, 'FAILED');
      const freshAttempt = await createAnalysis(pool, owner, hash, 'READY');

      await pool.query(
        `INSERT INTO analysis_leases (owner_user_id, kind, input_hash, current_analysis_id, lease_until)
         VALUES ($1, 'REPORT', $2, $3, now() - interval '1 second')`, [owner, hash, failedAttempt],
      );
      await pool.query(
        `UPDATE analysis_leases SET current_analysis_id = $3, lease_until = now() + interval '30 seconds',
           updated_at = now()
         WHERE owner_user_id = $1 AND kind = 'REPORT' AND input_hash = $2`, [owner, hash, freshAttempt],
      );

      const attempts = await pool.query<{ current_analysis_id: string }>(
        'SELECT current_analysis_id FROM analysis_leases WHERE owner_user_id = $1 AND kind = $2 AND input_hash = $3',
        [owner, 'REPORT', hash],
      );
      expect(attempts.rows[0].current_analysis_id).toBe(freshAttempt);
      expect(freshAttempt).not.toBe(failedAttempt);
    }));
});
