import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { PublicationReceiptSchema } from '../../../src/shared/contracts';
import { PostgresTransactionDatabase, type TransactionDatabase } from '../../../src/worker/db/client';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { apiSecurity } from '../../../src/worker/middleware/security';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import type { ReportMediaResolver } from '../../../src/worker/services/report-context';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const actorOne = 'publication-owner-one';
const actorTwo = 'publication-owner-two';
const context = {
  comment: 'Bag and packaging by the park bench.',
  measuredLocation: {
    lat: 49.14, lng: 9.22, accuracyM: 10, observedAt: new Date().toISOString(),
  },
  pin: { lat: 49.14001, lng: 9.22001 },
  cityId: 'heilbronn',
  outputLocale: 'en',
};
const accepted = {
  decision: 'ACCEPT', route: 'YELLOW', description: 'Several bags by a park bench.',
  hazardLevel: 'NONE', safetyMessage: '', reason: 'Visible litter is present.', confidence: 0.91,
};
const retake = {
  decision: 'RETAKE', reasonCode: 'INSUFFICIENT_EVIDENCE',
  reason: 'The scene is unclear.', instruction: 'Retake a closer photo.',
};

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
  await pool.query('INSERT INTO users (id, nickname) VALUES ($1::text, $2::varchar)', [id, `Public ${id}`]);
}

type AnalysisOptions = {
  owner?: string;
  photoCount?: number;
  result?: unknown;
  expired?: boolean;
  consumed?: boolean;
  expiredPhoto?: boolean;
  demo?: boolean;
};

async function createAnalysis(pool: Pool, options: AnalysisOptions = {}) {
  const owner = options.owner ?? actorOne;
  const photoIds: string[] = [];
  for (let ordinal = 0; ordinal < (options.photoCount ?? 1); ordinal++) {
    const photo = await pool.query<{ id: string }>(
      `INSERT INTO report_photos (
         owner_user_id, purpose, state, object_key, ordinal, mime_type, byte_size, sha256, upload_expires_at
       ) VALUES ($1::text, 'REPORT', 'UPLOADED', $2::varchar, $3::smallint, 'image/jpeg', 128,
         $4::char(64), CASE WHEN $5 THEN now() - interval '1 minute' ELSE now() + interval '5 minutes' END)
       RETURNING id`,
      [owner, `private/${crypto.randomUUID()}`, ordinal, 'a'.repeat(64), options.expiredPhoto ?? false],
    );
    photoIds.push(photo.rows[0].id);
  }
  const nowCreated = options.expired ? "now() - interval '2 minutes'" : 'now()';
  const expiry = options.expired ? "now() - interval '1 minute'" : "now() + interval '15 minutes'";
  const analysis = await pool.query<{ id: string; input_hash: string }>(
    `INSERT INTO ai_analyses (
       owner_user_id, kind, status, input_hash, photo_ids, context, result, expires_at,
       created_at, consumed_at, is_demo
     ) VALUES ($1::text, 'REPORT', 'READY', $2::varchar, $3::jsonb, $4::jsonb, $5::jsonb,
       ${expiry}, ${nowCreated}, CASE WHEN $6 THEN now() ELSE NULL END, $7::boolean)
     RETURNING id, input_hash`,
    [owner, `input-${crypto.randomUUID()}`, JSON.stringify(photoIds), JSON.stringify(context),
      JSON.stringify(options.result ?? accepted), options.consumed ?? false, options.demo ?? false],
  );
  await pool.query(
    `INSERT INTO analysis_leases (owner_user_id, kind, input_hash, current_analysis_id, lease_until)
     VALUES ($1::text, 'REPORT', $2::varchar, $3::uuid,
       CASE WHEN $4 THEN now() - interval '1 minute' ELSE now() + interval '15 minutes' END)`,
    [owner, analysis.rows[0].input_hash, analysis.rows[0].id, options.expired ?? false],
  );
  return { id: analysis.rows[0].id, photoIds, owner };
}

function createMediaResolver(): ReportMediaResolver {
  return {
    async resolveAttachedPhotos(photos) {
      return photos.map((photo) => ({
        id: photo.id,
        ordinal: photo.ordinal,
        mediaUrl: `https://media.invalid/${photo.id}?capability=short-lived-test-token`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }));
    },
  };
}

function createApp(
  pool: Pool,
  media?: ReportMediaResolver,
  database: TransactionDatabase = new PostgresTransactionDatabase(pool),
) {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.route('/api', createDomainRoutes({
    database,
    reportMedia: media,
    verify: async (token) => ({ uid: token }),
  }));
  app.onError(handleError);
  return app;
}

function publish(app: Hono<WorkerEnv>, owner: string, analysisId: string, key = crypto.randomUUID(), extra?: object) {
  return app.request('/api/reports', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ analysisId, description: 'Final resident description.', ...extra }),
  }, { FIREBASE_PROJECT_ID: 'publication-test-project' });
}

async function counts(pool: Pool, owner = actorOne) {
  const result = await pool.query<{ reports: number; ledger: number; balance: number; attached: number; }>(
    `SELECT
       (SELECT count(*)::int FROM reports WHERE author_user_id = $1::text) AS reports,
       (SELECT count(*)::int FROM reward_ledger WHERE user_id = $1::text AND kind = 'REPORT_INITIAL') AS ledger,
       (SELECT rp_balance FROM users WHERE id = $1::text) AS balance,
       (SELECT count(*)::int FROM report_photos WHERE owner_user_id = $1::text AND state = 'ATTACHED') AS attached`,
    [owner],
  );
  return result.rows[0];
}

describe('PostgreSQL report publication', () => {
  it('publishes one or five photos for the same initial reward and stores immutable analysis facts', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await createUser(pool, actorOne);
      await createUser(pool, actorTwo);
      const app = createApp(pool, createMediaResolver());

      for (const photoCount of [1, 5]) {
        const owner = photoCount === 1 ? actorOne : actorTwo;
        const analysis = await createAnalysis(pool, { owner, photoCount });
        const response = await publish(app, owner, analysis.id);
        expect(response.status).toBe(201);
        const receipt = PublicationReceiptSchema.parse(await response.json());
        expect(receipt).toMatchObject({
          rpAwarded: 5,
          balance: 5,
          balanceVersion: 1,
          report: {
            route: 'YELLOW',
            status: 'AWAITING_EXISTENCE',
            description: 'Final resident description.',
            location: context.pin,
            beforePhotos: analysis.photoIds.map((id, index) => ({ id, ordinal: index + 1 })),
            author: { id: owner },
          },
        });
        const stored = await pool.query<{
          report_id: string; analysis_id: string; description: string; original_ai_description: string;
          comment: string; reporter_total_rp: number; initial_rp: number; cleaner_rp: number;
        }>(
          `SELECT id AS report_id, analysis_id, description, original_ai_description, comment,
             reporter_total_rp, initial_rp, cleaner_rp FROM reports WHERE author_user_id = $1::text`,
          [owner],
        );
        expect(stored.rows[0]).toMatchObject({
          analysis_id: analysis.id,
          description: 'Final resident description.',
          original_ai_description: accepted.description,
          comment: context.comment,
          reporter_total_rp: 20,
          initial_rp: 5,
          cleaner_rp: 40,
        });
        expect((await counts(pool, owner))).toMatchObject({
          reports: 1, ledger: 1, balance: 5, attached: photoCount,
        });
      }
    }));

  it('replays concurrent same-key publication once and rejects another key for the consumed analysis', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await createUser(pool, actorOne);
      const analysis = await createAnalysis(pool, { photoCount: 2 });
      const app = createApp(pool, createMediaResolver());
      const key = crypto.randomUUID();

      const responses = await Promise.all([
        publish(app, actorOne, analysis.id, key),
        publish(app, actorOne, analysis.id, key),
      ]);
      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      const receipts = await Promise.all(responses.map(async (response) =>
        PublicationReceiptSchema.parse(await response.json())));
      expect(new Set(receipts.map((receipt) => receipt.report.id)).size).toBe(1);
      expect(receipts.map((receipt) => receipt.rpAwarded).sort()).toEqual([0, 5]);
      const replay = PublicationReceiptSchema.parse(
        await (await publish(app, actorOne, analysis.id, key)).json(),
      );
      expect(replay.rpAwarded).toBe(0);
      expect(replay.report.id).toBe(receipts[0].report.id);
      expect((await counts(pool))).toMatchObject({ reports: 1, ledger: 1, balance: 5, attached: 2 });

      const duplicate = await publish(app, actorOne, analysis.id, crypto.randomUUID());
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ error: { code: 'ANALYSIS_CONSUMED' } });
      expect((await counts(pool))).toMatchObject({ reports: 1, ledger: 1, balance: 5, attached: 2 });

      const conflict = await publish(app, actorOne, analysis.id, key, { description: 'Changed payload.' });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect((await counts(pool))).toMatchObject({ reports: 1, ledger: 1, balance: 5, attached: 2 });
    }));

  it('returns the committed initial snapshot when a vote verifies the report before response projection', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await createUser(pool, actorOne);
      const analysis = await createAnalysis(pool);
      const base = new PostgresTransactionDatabase(pool);
      let transitioned = false;
      const database: TransactionDatabase = {
        async withTransaction(work) {
          const value = await base.withTransaction(work);
          if (!transitioned) {
            transitioned = true;
            await pool.query(
              `UPDATE reports SET status = 'VERIFIED', existence_yes_count = 3,
                 existence_verified_at = now(), last_existence_confirmed_at = now(),
                 version = version + 1, updated_at = now()
               WHERE analysis_id = $1::uuid`,
              [analysis.id],
            );
          }
          return value;
        },
      };
      const app = createApp(pool, createMediaResolver(), database);
      const key = crypto.randomUUID();
      const response = await publish(app, actorOne, analysis.id, key);
      expect(response.status).toBe(201);
      const receipt = PublicationReceiptSchema.parse(await response.json());
      expect(receipt).toMatchObject({
        rpAwarded: 5,
        report: { status: 'AWAITING_EXISTENCE', existenceYesCount: 0 },
      });
      expect((await pool.query<{ status: string }>(
        'SELECT status FROM reports WHERE analysis_id = $1::uuid', [analysis.id],
      )).rows[0].status).toBe('VERIFIED');
      const replay = PublicationReceiptSchema.parse(
        await (await publish(app, actorOne, analysis.id, key)).json(),
      );
      expect(replay).toMatchObject({ rpAwarded: 0, report: { status: 'VERIFIED', existenceYesCount: 3 } });
    }));

  it('rejects invalid, unowned, expired, consumed and demo analyses without partial effects', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await createUser(pool, actorOne);
      await createUser(pool, actorTwo);
      const retakeAnalysis = await createAnalysis(pool, { result: retake });
      const expiredAnalysis = await createAnalysis(pool, { expired: true });
      const consumedAnalysis = await createAnalysis(pool, { consumed: true });
      const expiredPhotoAnalysis = await createAnalysis(pool, { expiredPhoto: true });
      const demoAnalysis = await createAnalysis(pool, { demo: true });
      const otherOwnerAnalysis = await createAnalysis(pool, { owner: actorTwo });
      const app = createApp(pool, createMediaResolver());

      const invalidBody = await publish(app, actorOne, retakeAnalysis.id, crypto.randomUUID(), { route: 'GREEN' });
      expect(invalidBody.status).toBe(400);
      expect(await invalidBody.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      expect((await publish(app, actorOne, retakeAnalysis.id)).status).toBe(422);
      expect((await publish(app, actorOne, expiredAnalysis.id)).status).toBe(410);
      expect((await publish(app, actorOne, consumedAnalysis.id)).status).toBe(409);
      expect((await publish(app, actorOne, expiredPhotoAnalysis.id)).status).toBe(410);
      const demo = await publish(app, actorOne, demoAnalysis.id);
      expect(demo.status).toBe(403);
      const unowned = await publish(app, actorOne, otherOwnerAnalysis.id);
      expect(unowned.status).toBe(404);

      expect((await counts(pool))).toMatchObject({ reports: 0, ledger: 0, balance: 0, attached: 0 });
      expect((await pool.query<{ consumed_at: Date | null; status: string }>(
        `SELECT consumed_at, status FROM ai_analyses WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[retakeAnalysis.id, expiredAnalysis.id, consumedAnalysis.id, expiredPhotoAnalysis.id, demoAnalysis.id,
          otherOwnerAnalysis.id]],
      )).rows.filter((row) => row.consumed_at !== null).length).toBe(1);
      expect((await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM idempotency_keys WHERE operation = 'REPORT_PUBLICATION'`,
      )).rows[0].count).toBe(0);
    }));

  it('returns unavailable before mutation when media capabilities are not injected', () =>
    withTestDatabase(async (pool) => {
      await installSchema(pool);
      await createUser(pool, actorOne);
      const analysis = await createAnalysis(pool);
      const response = await publish(createApp(pool), actorOne, analysis.id);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
      expect((await counts(pool))).toMatchObject({ reports: 0, ledger: 0, balance: 0, attached: 0 });
    }));
});
