import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresTransactionDatabase } from '../../../src/worker/db/client';
import {
  acceleratedDemoVoteIdentityLabel,
  DEMO_MARKER_KEY,
  DEMO_MARKER_OPERATION,
  DEMO_SEED_OBJECT_PREFIX,
  DEMO_SEED_USER_IDS,
  PostgresDemoSeedService,
  stableUuid,
} from '../../../src/worker/services/demo-seeds';
import { PostgresReportVotingService } from '../../../src/worker/services/voting';
import type { ReportMediaResolver } from '../../../src/worker/services/report-context';
import { resetDemoSeed, type DemoObjectStore } from '../../../scripts/reset-demo';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const fixtureBytes = await readFile(new URL('../../../tests/fixtures/photos/restart.jpg', import.meta.url));
const photoFixture = {
  byteSize: fixtureBytes.byteLength,
  sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
};

async function installDemoSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(migration);
    await client.query(
      'CREATE TABLE demo_seed_metadata ('
        + 'singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), '
        + "environment text NOT NULL CHECK (environment = 'demo'), "
        + 'database_name text NOT NULL, database_user text NOT NULL, schema_name text NOT NULL, '
        + 'schema_version integer NOT NULL CHECK (schema_version = 1))',
    );
    await client.query(
      "INSERT INTO demo_seed_metadata (environment, database_name, database_user, schema_name, schema_version) "
        + "SELECT 'demo', current_database(), current_user, current_schema(), 1",
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function createMediaResolver(): ReportMediaResolver {
  return {
    async resolveAttachedPhotos(photos) {
      return photos.map((photo) => ({
        id: photo.id,
        ordinal: photo.ordinal,
        mediaUrl: 'https://media.invalid/' + photo.id,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }));
    },
  };
}

async function seedDemo(pool: Pool): Promise<PostgresDemoSeedService> {
  const service = new PostgresDemoSeedService(
    new PostgresTransactionDatabase(pool), createMediaResolver(), photoFixture,
  );
  await service.seed();
  return service;
}

async function insertUnrelatedAttachedData(pool: Pool) {
  const userId = 'unrelated-resident';
  const analysisId = crypto.randomUUID();
  const reportId = crypto.randomUUID();
  const photoId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO users (id, nickname, is_demo) VALUES ($1::text, 'Unrelated', false)", [userId],
  );
  await pool.query(
    "INSERT INTO ai_analyses (id, owner_user_id, kind, status, input_hash, photo_ids, context, result, expires_at) "
      + "VALUES ($1::uuid, $2::text, 'REPORT', 'READY', $3::varchar, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour')",
    [analysisId, userId, 'unrelated-' + analysisId],
  );
  await pool.query(
    "INSERT INTO reports (id, author_user_id, route, description, lat, lng, measured_lat, measured_lng, "
      + 'accuracy_m, captured_location_at, analysis_id) '
      + "VALUES ($1::uuid, $2::text, 'RED', 'Unrelated report', 49.14, 9.22, 49.14, 9.22, 10, now(), $3::uuid)",
    [reportId, userId, analysisId],
  );
  await pool.query(
    "INSERT INTO report_photos (id, owner_user_id, report_id, purpose, state, object_key, ordinal, mime_type, "
      + 'byte_size, sha256, upload_expires_at) '
      + "VALUES ($1::uuid, $2::text, $3::uuid, 'REPORT', 'ATTACHED', $4::varchar, 0, 'image/jpeg', 16, $5::char(64), now() + interval '1 hour')",
    [photoId, userId, reportId, 'foreign-data/keep-me.jpg', 'a'.repeat(64)],
  );
  return { userId, reportId, photoId };
}

describe('guarded demo reset', () => {
  it('deletes only the marked seed, removes its exact object keys, and preserves unrelated attached data', () =>
    withTestDatabase(async (pool) => {
      await installDemoSchema(pool);
      const seed = await seedDemo(pool);
      const unrelated = await insertUnrelatedAttachedData(pool);
      const objectStore = {
        deleted: [] as string[],
        async deleteObjectKeys(keys: readonly string[]) { this.deleted.push(...keys); },
      };

      const reset = await resetDemoSeed(new PostgresTransactionDatabase(pool), objectStore);
      expect(reset.alreadyReset).toBe(false);
      expect(reset.deleted).toMatchObject({ users: 14, reports: 3, analyses: 4, leases: 4,
        cleanups: 1, photos: 4, votes: 10, ledger: 15, notifications: 2 });
      expect(reset.deleted.idempotencyKeys).toBeGreaterThanOrEqual(15);
      expect(reset.objectKeysProcessed).toBe(4);
      expect(objectStore.deleted).toHaveLength(4);
      expect(objectStore.deleted.every((key) => key.startsWith(DEMO_SEED_OBJECT_PREFIX))).toBe(true);

      const after = await pool.query<{
        demo_users: number; demo_reports: number; demo_analyses: number; demo_photos: number;
        foreign_user: number; foreign_report: number; foreign_photo: number; marker: number;
      }>(
        'SELECT '
          + '(SELECT count(*)::int FROM users WHERE id = ANY($1::text[])) AS demo_users, '
          + '(SELECT count(*)::int FROM reports WHERE author_user_id = ANY($1::text[])) AS demo_reports, '
          + '(SELECT count(*)::int FROM ai_analyses WHERE owner_user_id = ANY($1::text[])) AS demo_analyses, '
          + '(SELECT count(*)::int FROM report_photos WHERE object_key LIKE $2::varchar) AS demo_photos, '
          + '(SELECT count(*)::int FROM users WHERE id = $3::text) AS foreign_user, '
          + '(SELECT count(*)::int FROM reports WHERE id = $4::uuid) AS foreign_report, '
          + '(SELECT count(*)::int FROM report_photos WHERE id = $5::uuid) AS foreign_photo, '
          + '(SELECT count(*)::int FROM idempotency_keys WHERE user_id = $6::text AND operation = $7::varchar AND key = $8::varchar) AS marker',
        [DEMO_SEED_USER_IDS, DEMO_SEED_OBJECT_PREFIX + '%', unrelated.userId, unrelated.reportId,
          unrelated.photoId, DEMO_SEED_USER_IDS[0], DEMO_MARKER_OPERATION, DEMO_MARKER_KEY],
      );
      expect(after.rows[0]).toEqual({
        demo_users: 0, demo_reports: 0, demo_analyses: 0, demo_photos: 0,
        foreign_user: 1, foreign_report: 1, foreign_photo: 1, marker: 0,
      });

      const repeated = await resetDemoSeed(new PostgresTransactionDatabase(pool), objectStore);
      expect(repeated.alreadyReset).toBe(true);
      expect(objectStore.deleted).toHaveLength(4);
      expect((await seed.seed()).alreadySeeded).toBe(false);
    }));

  it('resets only registered accelerated demo vote slots and their exact receipts', () =>
    withTestDatabase(async (pool) => {
      await installDemoSchema(pool);
      await seedDemo(pool);
      const reportId = await stableUuid('report/yellow-pending');
      const voterId = DEMO_SEED_USER_IDS[4]!;
      const identity = acceleratedDemoVoteIdentityLabel(reportId, voterId, 'EXISTENCE');
      const voteId = await stableUuid('vote/accelerated/' + identity);
      const key = await stableUuid('idempotency/accelerated/' + identity);
      const now = Date.now();
      const service = new PostgresReportVotingService(
        new PostgresTransactionDatabase(pool), createMediaResolver(), () => now,
      );
      const accelerated = await service.vote(voterId, key, reportId, {
        stage: 'EXISTENCE',
        choice: 'YES',
        location: { lat: 49.14, lng: 9.22, accuracyM: 10, observedAt: new Date(now).toISOString() },
      }, { deterministicVoteId: voteId, demoProvenance: 'accelerated-sandbox' });
      expect(accelerated.receipt).toMatchObject({ rpAwarded: 5, replayed: false });

      const objectStore = {
        deleted: [] as string[],
        async deleteObjectKeys(keys: readonly string[]) { this.deleted.push(...keys); },
      };
      const reset = await resetDemoSeed(new PostgresTransactionDatabase(pool), objectStore);
      expect(reset.deleted).toMatchObject({ votes: 11, ledger: 16, notifications: 3, idempotencyKeys: 16 });
      expect(objectStore.deleted).toHaveLength(4);
      expect((await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM votes WHERE id = $1::uuid', [voteId],
      )).rows[0]?.count).toBe(0);
    }));

  it('refuses to remove non-demo rows attached to a seeded report', () =>
    withTestDatabase(async (pool) => {
      await installDemoSchema(pool);
      await seedDemo(pool);
      const outsider = 'foreign-voter';
      await pool.query(
        "INSERT INTO users (id, nickname, is_demo) VALUES ($1::text, 'Foreign voter', false)", [outsider],
      );
      const reportId = await stableUuid('report/green-resolved');
      await pool.query(
        "INSERT INTO votes (id, report_id, stage, voter_user_id, choice, distance_m, accuracy_m, is_demo) "
          + "VALUES ($1::uuid, $2::uuid, 'EXISTENCE', $3::text, 'YES', 10, 10, false)",
        [crypto.randomUUID(), reportId, outsider],
      );
      let objectDeleteCalled = false;
      const objectStore: DemoObjectStore = {
        async deleteObjectKeys() { objectDeleteCalled = true; },
      };

      await expect(resetDemoSeed(new PostgresTransactionDatabase(pool), objectStore))
        .rejects.toThrow('A non-demo or unknown vote is attached to the seed');
      expect(objectDeleteCalled).toBe(false);
      expect((await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM votes WHERE voter_user_id = $1::text', [outsider],
      )).rows[0]?.count).toBe(1);
      expect((await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM users WHERE id = $1::text', [DEMO_SEED_USER_IDS[0]],
      )).rows[0]?.count).toBe(1);
    }));

  it.each(['missing schema marker', 'mismatched schema marker'] as const)(
    'refuses reset with a %s before deleting objects', (markerCase) =>
      withTestDatabase(async (pool) => {
        await installDemoSchema(pool);
        await seedDemo(pool);
        if (markerCase === 'missing schema marker') {
          await pool.query('DROP TABLE demo_seed_metadata');
        } else {
          await pool.query("UPDATE demo_seed_metadata SET schema_name = 'wrong_schema' WHERE singleton = true");
        }
        let objectDeleteCalled = false;
        const objectStore: DemoObjectStore = {
          async deleteObjectKeys() { objectDeleteCalled = true; },
        };

        await expect(resetDemoSeed(new PostgresTransactionDatabase(pool), objectStore)).rejects.toThrow(
          markerCase === 'missing schema marker'
            ? 'Demo seed metadata is missing'
            : 'Demo seed database identity does not match',
        );
        expect(objectDeleteCalled).toBe(false);
      }));

  it('refuses unknown seed-account receipts and shape-valid but unlisted photo keys before deleting objects', () =>
    withTestDatabase(async (pool) => {
      await installDemoSchema(pool);
      await seedDemo(pool);
      const outsiderKey = 'operator-note';
      await pool.query(
        `INSERT INTO idempotency_keys (user_id, operation, key, request_hash)
         VALUES ($1::text, 'OPERATOR_NOTE', $2::varchar, 'operator-note-v1')`,
        [DEMO_SEED_USER_IDS[0], outsiderKey],
      );
      let objectDeleteCalled = false;
      const objectStore = { async deleteObjectKeys() { objectDeleteCalled = true; } };
      await expect(resetDemoSeed(new PostgresTransactionDatabase(pool), objectStore))
        .rejects.toThrow('An unknown idempotency row is attached to the seed');
      expect(objectDeleteCalled).toBe(false);
      await pool.query(
        'DELETE FROM idempotency_keys WHERE user_id = $1::text AND operation = $2::varchar AND key = $3::varchar',
        [DEMO_SEED_USER_IDS[0], 'OPERATOR_NOTE', outsiderKey],
      );

      const knownPhotoId = await stableUuid('photo/report/green-resolved/before');
      await pool.query(
        'UPDATE report_photos SET object_key = $2::varchar WHERE id = $1::uuid',
        [knownPhotoId, DEMO_SEED_OBJECT_PREFIX + 'green-resolved/before-' + 'f'.repeat(64) + '.jpg'],
      );
      await expect(resetDemoSeed(new PostgresTransactionDatabase(pool), objectStore))
        .rejects.toThrow('A foreign or unlisted photo is attached to the seed');
      expect(objectDeleteCalled).toBe(false);
    }));

  it('refuses an unrelated ledger row referencing a seeded vote before object deletion', () =>
    withTestDatabase(async (pool) => {
      await installDemoSchema(pool);
      await seedDemo(pool);
      const outsider = 'foreign-ledger-voter';
      await pool.query(
        "INSERT INTO users (id, nickname, is_demo) VALUES ($1::text, 'Foreign ledger user', false)", [outsider],
      );
      const voteId = await stableUuid('vote/green-existence-1');
      await pool.query('DELETE FROM reward_ledger WHERE source_ref = $1::varchar', ['vote:' + voteId]);
      await pool.query(
        `INSERT INTO reward_ledger (user_id, kind, delta, source_ref, vote_id, is_demo)
         VALUES ($1::text, 'VOTE', 5, 'foreign-vote-ledger', $2::uuid, false)`,
        [outsider, voteId],
      );
      let objectDeleteCalled = false;
      const objectStore: DemoObjectStore = {
        async deleteObjectKeys() { objectDeleteCalled = true; },
      };

      await expect(resetDemoSeed(new PostgresTransactionDatabase(pool), objectStore))
        .rejects.toThrow('A non-demo or unknown ledger entry is attached to the seed');
      expect(objectDeleteCalled).toBe(false);
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM reward_ledger WHERE source_ref = 'foreign-vote-ledger'",
      )).rows[0]?.count).toBe(1);
    }));

  it('holds seeded FK parent locks while deleting objects so concurrent foreign references cannot race the reset', () =>
    withTestDatabase(async (pool) => {
      await installDemoSchema(pool);
      await seedDemo(pool);
      const outsider = 'concurrent-ledger-user';
      await pool.query(
        "INSERT INTO users (id, nickname, is_demo) VALUES ($1::text, 'Concurrent ledger user', false)", [outsider],
      );
      const voteId = await stableUuid('vote/green-existence-1');
      let enterObjectDelete!: () => void;
      let releaseObjectDelete!: () => void;
      const objectDeleteEntered = new Promise<void>((resolve) => { enterObjectDelete = resolve; });
      const waitForObjectDelete = new Promise<void>((resolve) => { releaseObjectDelete = resolve; });
      const reset = resetDemoSeed(new PostgresTransactionDatabase(pool), {
        async deleteObjectKeys() {
          enterObjectDelete();
          await waitForObjectDelete;
        },
      });
      await objectDeleteEntered;

      const insertion = pool.query(
        `INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id, is_demo)
         VALUES ($1::text, 'VOTE', 5, 'concurrent-report-ledger', $2::uuid, false)`,
        [outsider, await stableUuid('report/green-resolved')],
      ).then(() => ({ status: 'inserted' as const }), (error: unknown) => ({ status: 'rejected' as const, error }));
      const raced = await Promise.race([
        insertion.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(raced).toBe('blocked');

      releaseObjectDelete();
      await reset;
      const insertResult = await insertion;
      expect(insertResult.status).toBe('rejected');
      if (insertResult.status === 'rejected') {
        expect(insertResult.error).toMatchObject({ code: '23503' });
      }
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM reward_ledger WHERE source_ref = 'concurrent-report-ledger'",
      )).rows[0]?.count).toBe(0);
    }));

  it('records reset intent before object deletion and safely resumes after an object-store failure', () =>
    withTestDatabase(async (pool) => {
      await installDemoSchema(pool);
      const seed = await seedDemo(pool);
      const database = new PostgresTransactionDatabase(pool);
      const failedStore: DemoObjectStore = {
        async deleteObjectKeys() { throw new Error('simulated object-store outage'); },
      };
      await expect(resetDemoSeed(database, failedStore)).rejects.toThrow('simulated object-store outage');

      const pending = await pool.query<{ response_body: unknown }>(
        'SELECT response_body FROM idempotency_keys WHERE user_id = $1::text '
          + 'AND operation = $2::varchar AND key = $3::varchar',
        [DEMO_SEED_USER_IDS[0], DEMO_MARKER_OPERATION, DEMO_MARKER_KEY],
      );
      expect(pending.rows[0]?.response_body).toMatchObject({ resetState: 'pending', objectKeys: expect.any(Array) });
      await expect(seed.seed()).rejects.toThrow('Demo seed reset is pending');

      const deleted: string[] = [];
      const recovered = await resetDemoSeed(database, {
        async deleteObjectKeys(keys) { deleted.push(...keys); },
      });
      expect(recovered.alreadyReset).toBe(false);
      expect(deleted).toHaveLength(4);
      expect((await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM users WHERE id = ANY($1::text[])', [DEMO_SEED_USER_IDS],
      )).rows[0]?.count).toBe(0);
    }));
});
