import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../src/worker/index';
import { admitUpload } from '../../../src/worker/db/evidence-store';
import type { TransactionDatabase } from '../../../src/worker/db/client';
import { authorizeUpload } from '../../../src/worker/routes/uploads';
import { UploadTicketSchema } from '../../../src/shared/contracts';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const secret = 'test-only-private-upload-signing-key-32-plus';
const request = { purpose: 'REPORT', mimeType: 'image/jpeg', byteSize: 123, ordinal: 1 } as const;

// Test-only adapter; runtime wiring belongs to #19 and B's transaction implementation (#78).
function databaseFor(pool: Pool): TransactionDatabase {
  return {
    async withTransaction(work) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await work({
          query: async (text, parameters) => connection.query(text, parameters ? [...parameters] : undefined),
        });
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

async function prepare(pool: Pool) {
  await pool.query(migration);
  await pool.query("INSERT INTO users (id, nickname) VALUES ('resident', 'Test resident')");
  const analysis = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses (owner_user_id, kind, status, input_hash)
     VALUES ('resident', 'REPORT', 'RUNNING', 'test-only') RETURNING id`,
  );
  const report = await pool.query<{ id: string }>(
    `INSERT INTO reports (author_user_id, route, status, description, lat, lng,
       measured_lat, measured_lng, accuracy_m, captured_location_at, analysis_id,
       existence_yes_count, existence_verified_at, last_existence_confirmed_at)
     VALUES ('resident', 'GREEN', 'VERIFIED', 'Controlled test scene', 49.14, 9.22,
       49.14, 9.22, 10, now(), $1, 3, now(), now()) RETURNING id`, [analysis.rows[0].id],
  );
  return { database: databaseFor(pool), reportId: report.rows[0].id };
}

describe('upload admission against the real P0 PostgreSQL schema', () => {
  it('uses the Firebase UID account, requires bootstrap, and never creates evidence/cleanup/ledger rows', () =>
    withTestDatabase(async (pool) => {
      const { database, reportId } = await prepare(pool);
      await admitUpload(database, 'resident', request);
      await admitUpload(database, 'resident', { ...request, purpose: 'CLEANUP', reportId });
      await expect(admitUpload(database, 'not-bootstrapped', request))
        .rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
      for (const table of ['report_photos', 'cleanup_submissions', 'reward_ledger']) {
        expect((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
      }
    }));

  it('rejects absent and ineligible cleanup targets without claiming the cleanup', () =>
    withTestDatabase(async (pool) => {
      const { database, reportId } = await prepare(pool);
      await expect(admitUpload(database, 'resident', { ...request, purpose: 'CLEANUP', reportId: crypto.randomUUID() }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      for (const route of ['YELLOW', 'RED']) {
        await pool.query('UPDATE reports SET route = $1 WHERE id = $2', [route, reportId]);
        await expect(admitUpload(database, 'resident', { ...request, purpose: 'CLEANUP', reportId }))
          .rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
      }
      await pool.query("UPDATE reports SET route = 'GREEN' WHERE id = $1", [reportId]);
      for (const status of ['AWAITING_RESOLUTION', 'RESOLVED', 'AWAITING_EXISTENCE']) {
        await pool.query(
          `UPDATE reports SET status = $1::report_lifecycle,
             existence_yes_count = CASE WHEN $1 = 'AWAITING_EXISTENCE' THEN 0 ELSE 3 END,
             existence_verified_at = CASE WHEN $1 = 'AWAITING_EXISTENCE' THEN NULL ELSE now() END,
             last_existence_confirmed_at = CASE WHEN $1 = 'AWAITING_EXISTENCE' THEN NULL ELSE now() END,
             resolution_yes_count = CASE WHEN $1 = 'RESOLVED' THEN 3 ELSE 0 END,
             resolved_at = CASE WHEN $1 = 'RESOLVED' THEN now() ELSE NULL END
           WHERE id = $2`, [status, reportId],
        );
        await expect(admitUpload(database, 'resident', { ...request, purpose: 'CLEANUP', reportId }))
          .rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
      }
      expect((await pool.query('SELECT count(*)::int AS count FROM cleanup_submissions')).rows[0].count).toBe(0);
    }));

  it('rechecks cleanup eligibility when consuming a genuine signed ticket', () =>
    withTestDatabase(async (pool) => {
      const { database, reportId } = await prepare(pool);
      const app = createApp({ database, verify: async () => ({ uid: 'resident' }) });
      const response = await app.request('https://iskra.test/api/uploads', {
        method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, purpose: 'CLEANUP', reportId }),
      }, { FIREBASE_PROJECT_ID: 'iskra-test', MEDIA_SIGNING_SECRET: secret });
      expect(response.status).toBe(201);
      const ticket = UploadTicketSchema.parse(await response.json());
      const token = new URL(ticket.uploadUrl).searchParams.get('ticket')!;
      const admitted = await authorizeUpload(token, 'resident', ticket.photoId, 'https://iskra.test', secret, database);
      expect(admitted.request).toEqual({ ...request, purpose: 'CLEANUP', reportId });
      await pool.query("UPDATE reports SET status = 'AWAITING_RESOLUTION' WHERE id = $1", [reportId]);
      await expect(authorizeUpload(token, 'resident', ticket.photoId, 'https://iskra.test', secret, database))
        .rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    }));

  it('rejects used photo IDs regardless of RESERVED/UPLOADED/ATTACHED state', () =>
    withTestDatabase(async (pool) => {
      const { database, reportId } = await prepare(pool);
      const photoId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO report_photos (id, owner_user_id, purpose, object_key, ordinal, mime_type,
           byte_size, sha256, upload_expires_at)
         VALUES ($1, 'resident', 'REPORT', $2, 0, 'image/jpeg', 123, $3, now() + interval '5 minutes')`,
        [photoId, `photos/${photoId}`, 'a'.repeat(64)],
      );
      for (const state of ['RESERVED', 'UPLOADED', 'ATTACHED']) {
        await pool.query('UPDATE report_photos SET state = $1, report_id = $2 WHERE id = $3',
          [state, state === 'ATTACHED' ? reportId : null, photoId]);
        await expect(admitUpload(database, 'resident', request, photoId))
          .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      }
      expect((await pool.query('SELECT state, sha256 FROM report_photos WHERE id = $1', [photoId])).rows[0])
        .toEqual({ state: 'ATTACHED', sha256: 'a'.repeat(64) });
    }));
});
