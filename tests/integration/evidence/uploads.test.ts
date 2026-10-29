import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/worker/index';
import { admitUpload } from '../../../src/worker/db/evidence-store';
import type { TransactionDatabase } from '../../../src/worker/db/client';
import { authorizeUpload } from '../../../src/worker/routes/uploads';
import { UploadTicketSchema } from '../../../src/shared/contracts';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const secret = 'test-only-private-upload-signing-key-32-plus';
const request = { purpose: 'REPORT', mimeType: 'image/jpeg', byteSize: 123, ordinal: 1 } as const;
const jpeg = new Uint8Array(await readFile(new URL('../../fixtures/photos/grayscale.jpg', import.meta.url)));

// Test-only adapter; production runtime injection belongs to #19.
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

async function prepareFinalization(pool: Pool) {
  const { database } = await prepare(pool);
  const objects = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, bytes: Uint8Array) => {
    if (objects.has(key)) return null;
    objects.set(key, bytes.slice());
    return { key };
  });
  const env = { FIREBASE_PROJECT_ID: 'iskra-test', MEDIA_SIGNING_SECRET: secret, PHOTOS: { put } as unknown as R2Bucket };
  const app = createApp({ database, verify: async () => ({ uid: 'resident' }) });
  const response = await app.request('https://iskra.test/api/uploads', {
    method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, byteSize: jpeg.length, ordinal: 5 }),
  }, env);
  expect(response.status).toBe(201);
  const ticket = UploadTicketSchema.parse(await response.json());
  const upload = () => app.request(ticket.uploadUrl, {
    method: 'PUT', headers: { Authorization: 'Bearer test', 'Content-Type': 'image/jpeg' }, body: jpeg,
  }, env);
  return { ticket, upload, objects, put };
}

describe('report finalization with real PostgreSQL and an explicit conditional R2 double', () => {
  it('commits one immutable row under simultaneous uploads, stores the actual hash and never awards RP', () =>
    withTestDatabase(async (pool) => {
      const { ticket, upload, objects } = await prepareFinalization(pool);
      const responses = await Promise.all([upload(), upload()]);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      const bytes = objects.get(`photos/${ticket.photoId}`)!;
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes.slice())).toString('hex');
      const rows = await pool.query(
        'SELECT id, owner_user_id, purpose, state, ordinal, byte_size, sha256, report_id, cleanup_id FROM report_photos',
      );
      expect(rows.rows).toEqual([{
        id: ticket.photoId, owner_user_id: 'resident', purpose: 'REPORT', state: 'UPLOADED', ordinal: 4,
        byte_size: bytes.length, sha256: hash, report_id: null, cleanup_id: null,
      }]);
      const snapshot = bytes.slice();
      expect((await upload()).status).toBe(409);
      expect(objects.get(`photos/${ticket.photoId}`)).toEqual(snapshot);
      expect((await pool.query('SELECT count(*)::int AS n FROM reward_ledger')).rows[0].n).toBe(0);
    }));

  it('retains only an unusable immutable object after SQL failure and cannot promote it by retry', () =>
    withTestDatabase(async (pool) => {
      const { ticket, upload, objects } = await prepareFinalization(pool);
      await pool.query(`CREATE FUNCTION fail_photo() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test-only SQL finalization failure'; END $$;
        CREATE TRIGGER fail_photo BEFORE INSERT ON report_photos FOR EACH ROW EXECUTE FUNCTION fail_photo()`);
      const response = await upload();
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('SQL finalization failure');
      expect(objects.size).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM report_photos')).rows[0].n).toBe(0);
      await pool.query('DROP TRIGGER fail_photo ON report_photos');
      expect((await upload()).status).toBe(409);
      expect(objects.has(`photos/${ticket.photoId}`)).toBe(true);
      expect((await pool.query('SELECT count(*)::int AS n FROM report_photos')).rows[0].n).toBe(0);
    }));

  it('rejects another finalized photo after ten in the same minute for one account', () =>
    withTestDatabase(async (pool) => {
      const { upload, put } = await prepareFinalization(pool);
      for (let n = 0; n < 10; n += 1) {
        const id = crypto.randomUUID();
        await pool.query(
          `INSERT INTO report_photos (id, owner_user_id, purpose, object_key, ordinal, mime_type,
             byte_size, sha256, upload_expires_at)
           VALUES ($1, 'resident', 'REPORT', $2, 0, 'image/jpeg', 123, $3, now() + interval '5 minutes')`,
          [id, `photos/${id}`, 'b'.repeat(64)],
        );
      }
      expect((await upload()).status).toBe(429);
      expect(put).not.toHaveBeenCalled();
      expect((await pool.query('SELECT count(*)::int AS n FROM report_photos')).rows[0].n).toBe(10);
    }));

  it('creates no SQL evidence when storage fails', () =>
    withTestDatabase(async (pool) => {
      const { upload, put, objects } = await prepareFinalization(pool);
      put.mockRejectedValueOnce(new Error('test-only storage failure'));
      expect((await upload()).status).toBe(503);
      expect(objects.size).toBe(0);
      expect((await pool.query('SELECT count(*)::int AS n FROM report_photos')).rows[0].n).toBe(0);
    }));
});

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
