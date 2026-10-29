import { vertexAuthJson, withVertexAuth } from '../../fixtures/ai/vertex';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanupAnalysisSchema, ReportAnalysisSchema } from '../../../src/shared/contracts';
import { PostgresTransactionDatabase, type TransactionDatabase } from '../../../src/worker/db/client';
import { beginReportAnalysis, finishReportAnalysis, readReportAnalysis, removeExpiredPhotos } from '../../../src/worker/db/evidence-store';
import { PostgresCleanupSubmissionService } from '../../../src/worker/services/cleanup';
import { createApp } from '../../../src/worker/index';
import { PostgresReportPublicationService } from '../../../src/worker/services/publication';
import { createReportMediaResolver } from '../../../src/worker/services/media';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const jpeg = new Uint8Array(await readFile(new URL('../../fixtures/photos/grayscale.jpg', import.meta.url)));
const hash = Buffer.from(await crypto.subtle.digest('SHA-256', jpeg)).toString('hex');
const assessment = { decision: 'ACCEPT', route: 'GREEN', description: 'Litter beside a path.', hazardLevel: 'NONE',
  safetyMessage: '', reason: 'Small visible litter.', confidence: 0.8 } as const;
const model = 'test-only-model';
const cleanupAssessment = { decision: 'ACCEPT', sameScene: 'LIKELY', appearsClean: true,
  hazardRemaining: false, reason: 'The litter is gone.', confidence: 0.9 } as const;

async function prepare(pool: Pool, count = 1) {
  await pool.query(migration);
  await pool.query("INSERT INTO users (id, nickname) VALUES ('resident', 'Resident'), ('other', 'Other')");
  const ids: string[] = [];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const id = crypto.randomUUID(); ids.push(id);
    await pool.query(
      `INSERT INTO report_photos (id, owner_user_id, purpose, state, object_key, ordinal, mime_type, byte_size, sha256, upload_expires_at)
       VALUES ($1, 'resident', 'REPORT', 'UPLOADED', $2, $3, 'image/jpeg', $4, $5, clock_timestamp() + interval '5 minutes')`,
      [id, 'photos/' + id, ordinal, jpeg.length, hash],
    );
  }
  return {
    database: new PostgresTransactionDatabase(pool),
    input: { photoIds: ids, comment: '', cityId: 'heilbronn' as const, outputLocale: 'en' as const,
      measuredLocation: { lat: 49.14, lng: 9.22, accuracyM: 10, observedAt: new Date().toISOString() },
      pin: { lat: 49.14, lng: 9.22 } },
  };
}

function modelResponse(result: unknown = assessment) {
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result) }] } }] });
}

async function prepareCleanup(pool: Pool, count = 1) {
  const { database, input } = await prepare(pool, count);
  await pool.query("UPDATE report_photos SET purpose = 'CLEANUP'");
  const reportAnalysis = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses (owner_user_id, kind, status, input_hash, result, expires_at)
     VALUES ('resident', 'REPORT', 'READY', 'report-binding', $1::jsonb, now() + interval '15 minutes') RETURNING id`,
    [JSON.stringify(assessment)],
  );
  const report = await pool.query<{ id: string }>(
    `INSERT INTO reports (author_user_id, route, status, description, lat, lng, measured_lat, measured_lng,
       accuracy_m, captured_location_at, analysis_id, existence_yes_count, existence_verified_at, last_existence_confirmed_at)
     VALUES ('resident', 'GREEN', 'VERIFIED', 'Litter beside a path.', 49.14, 9.22, 49.14, 9.22,
       10, now(), $1, 3, now(), now()) RETURNING id`, [reportAnalysis.rows[0].id],
  );
  const beforeBytes = new Uint8Array(await readFile(new URL('../../fixtures/photos/restart.jpg', import.meta.url)));
  const beforeHash = Buffer.from(await crypto.subtle.digest('SHA-256', beforeBytes)).toString('hex');
  const objects = new Map(input.photoIds.map((id) => ['photos/' + id, jpeg]));
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const id = crypto.randomUUID();
    objects.set('photos/' + id, beforeBytes);
    await pool.query(
      `INSERT INTO report_photos (id, owner_user_id, report_id, purpose, state, object_key, ordinal, mime_type,
         byte_size, sha256, upload_expires_at)
       VALUES ($1, 'resident', $2, 'REPORT', 'ATTACHED', $3, $4, 'image/jpeg', $5, $6, now() + interval '5 minutes')`,
      [id, report.rows[0].id, 'photos/' + id, ordinal, beforeBytes.length, beforeHash],
    );
  }
  return { database, objects, beforeBytes, input: {
    reportId: report.rows[0].id, photoIds: input.photoIds, outputLocale: 'de' as const, location: input.measuredLocation,
  } };
}

function appFor(database: TransactionDatabase, fetcher: typeof fetch = vi.fn(async () => modelResponse()),
  objects?: Map<string, Uint8Array<ArrayBuffer>>) {
  vi.stubGlobal('fetch', withVertexAuth(fetcher));
  const app = createApp({ database, verify: async (token) => ({ uid: token }) });
  const get = vi.fn(async (key: string) => {
    const bytes = objects ? objects.get(key) : jpeg;
    if (!bytes) throw new Error('Missing test object');
    return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
  });
  const env = { FIREBASE_PROJECT_ID: 'iskra-test', VERTEX_AUTH_JSON: vertexAuthJson, GEMINI_MODEL_ID: model,
    PHOTOS: { get } as unknown as R2Bucket };
  const start = (input: unknown, key = crypto.randomUUID(), uid = 'resident') => app.request('https://iskra.test/api/ai/analyze-report', {
    method: 'POST', headers: { Authorization: 'Bearer ' + uid, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(input),
  }, env);
  const poll = (id: string, uid = 'resident') => app.request('https://iskra.test/api/ai/analyses/' + id, {
    headers: { Authorization: 'Bearer ' + uid },
  }, env);
  const startCleanup = (input: unknown, key = crypto.randomUUID(), uid = 'resident') => app.request('https://iskra.test/api/ai/analyze-cleanup', {
    method: 'POST', headers: { Authorization: 'Bearer ' + uid, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(input),
  }, env);
  return { app, env, get, start, startCleanup, poll, fetcher };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('SQL report-analysis attempts and leases', () => {
  it('keeps the READY lease valid for its full accepted lifetime and produces consumable B publication inputs', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const work = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      expect(await finishReportAnalysis(database, 'resident', work.analysisId, assessment)).toBe(true);
      const lifetime = await pool.query(
        `SELECT l.lease_until = a.expires_at AS matching,
           extract(epoch FROM l.lease_until - clock_timestamp()) AS seconds
         FROM analysis_leases l JOIN ai_analyses a ON a.id = l.current_analysis_id`,
      );
      expect(lifetime.rows[0].matching).toBe(true);
      expect(Number(lifetime.rows[0].seconds)).toBeGreaterThan(1_790);
      await pool.query("UPDATE report_photos SET upload_expires_at = clock_timestamp() - interval '6 minutes'");
      const publisher = new PostgresReportPublicationService(database,
        createReportMediaResolver('https://iskra.test', 'test-only-signing-key-at-least-32-bytes'));
      const result = await publisher.publish('resident', crypto.randomUUID(), {
        analysisId: work.analysisId, description: assessment.description,
      });
      expect(result.receipt).toMatchObject({ rpAwarded: 5, report: { status: 'AWAITING_EXISTENCE', route: 'GREEN' } });
      expect((await pool.query('SELECT state FROM report_photos')).rows[0].state).toBe('ATTACHED');
      await expect(readReportAnalysis(database, 'resident', work.analysisId, crypto.randomUUID()))
        .rejects.toMatchObject({ code: 'EXPIRED' });
    }));
  it('shares active identical work across concurrent keys and resolves same-key replay before stale-location admission', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const keys = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      const results = await Promise.all(keys.map((key) => beginReportAnalysis(database, 'resident', key, input, model)));
      expect(new Set(results.map((v) => v.analysisId)).size).toBe(1);
      expect(results.filter((v) => v.started)).toHaveLength(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM ai_analyses')).rows[0].n).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM analysis_leases')).rows[0].n).toBe(1);
      const replay = await beginReportAnalysis(database, 'resident', keys[0], input, model, () => Date.now() + 120_000);
      expect(replay).toMatchObject({ analysisId: results[0].analysisId, started: false });
      await expect(beginReportAnalysis(database, 'resident', keys[0], { ...input, comment: 'Changed' }, model))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await expect(beginReportAnalysis(database, 'resident', crypto.randomUUID(), { ...input, comment: 'New' }, model, () => Date.now() + 120_000))
        .rejects.toMatchObject({ code: 'LOCATION_STALE' });
    }));

  it('checks the current location age after SQL admission waits rather than at request entry', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      let clock = Date.now();
      const delayed: TransactionDatabase = { withTransaction: (work) => database.withTransaction((client) => work({
        query: async <Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) => {
          const result = await client.query<Row>(sql, parameters);
          if (sql.includes('pg_advisory_xact_lock')) clock += 120_000;
          return result;
        },
      })) };
      await expect(beginReportAnalysis(delayed, 'resident', crypto.randomUUID(), input, model, () => clock))
        .rejects.toMatchObject({ code: 'LOCATION_STALE' });
      expect((await pool.query('SELECT count(*)::int AS n FROM ai_analyses')).rows[0].n).toBe(0);
    }));

  it('cannot finish or share an expired RUNNING row even if its lease remains active', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const first = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      await pool.query("UPDATE ai_analyses SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second'");
      expect(await finishReportAnalysis(database, 'resident', first.analysisId, assessment)).toBe(false);
      expect(await readReportAnalysis(database, 'resident', first.analysisId, crypto.randomUUID())).toMatchObject({ status: 'FAILED' });
      const next = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      expect(next.started).toBe(true); expect(next.analysisId).not.toBe(first.analysisId);
    }));

  it('cannot advertise or share READY evidence after its lease is revoked or expires', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const first = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      await finishReportAnalysis(database, 'resident', first.analysisId, assessment);
      await pool.query("UPDATE analysis_leases SET lease_until = clock_timestamp() - interval '1 second'");
      await expect(readReportAnalysis(database, 'resident', first.analysisId, crypto.randomUUID())).rejects.toMatchObject({ code: 'EXPIRED' });
      const next = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      expect(next.started).toBe(true); expect(next.analysisId).not.toBe(first.analysisId);
    }));

  it('creates a fresh identity after failure and never retargets an old operation key', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const key = crypto.randomUUID();
      const first = await beginReportAnalysis(database, 'resident', key, input, model);
      expect(await finishReportAnalysis(database, 'resident', first.analysisId, null)).toBe(true);
      const next = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      expect(next.started).toBe(true); expect(next.analysisId).not.toBe(first.analysisId);
      const replay = await beginReportAnalysis(database, 'resident', key, input, model);
      expect(replay).toMatchObject({ analysisId: first.analysisId, started: false });
      expect(await finishReportAnalysis(database, 'resident', first.analysisId, assessment)).toBe(false);
      expect(await finishReportAnalysis(database, 'resident', next.analysisId, assessment)).toBe(true);
      expect(await readReportAnalysis(database, 'resident', next.analysisId, crypto.randomUUID()))
        .toMatchObject({ status: 'READY', result: assessment });
      await expect(readReportAnalysis(database, 'other', next.analysisId, crypto.randomUUID()))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    }));

  it('rejects a late reply after lease expiry/replacement and expires READY without resurrecting its old ID', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const first = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      await pool.query("UPDATE analysis_leases SET lease_until = clock_timestamp() - interval '1 second'");
      expect(await finishReportAnalysis(database, 'resident', first.analysisId, assessment)).toBe(false);
      const next = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      expect(await finishReportAnalysis(database, 'resident', first.analysisId, assessment)).toBe(false);
      expect(await finishReportAnalysis(database, 'resident', next.analysisId, assessment)).toBe(true);
      await pool.query("UPDATE ai_analyses SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 minute' WHERE id = $1", [next.analysisId]);
      await expect(readReportAnalysis(database, 'resident', next.analysisId, crypto.randomUUID())).rejects.toMatchObject({ code: 'EXPIRED' });
      const third = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      expect(third.analysisId).not.toBe(next.analysisId);
      expect((await pool.query('SELECT count(*)::int AS n FROM ai_analyses')).rows[0].n).toBe(3);
    }));

  it('enforces five new attempts per UID per minute under concurrent distinct inputs, without claiming a sixth receipt', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, n) =>
        beginReportAnalysis(database, 'resident', crypto.randomUUID(), { ...input, comment: 'Attempt ' + n }, model)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'RATE_LIMITED' });
      expect((await pool.query('SELECT count(*)::int AS n FROM idempotency_keys')).rows[0].n).toBe(5);
      expect((await pool.query('SELECT count(*)::int AS n FROM ai_analyses')).rows[0].n).toBe(5);
    }));

  it('rejects foreign, incorrectly ordered, beyond-retention and moved-pin evidence before starting work', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool, 2);
      await expect(beginReportAnalysis(database, 'other', crypto.randomUUID(), input, model)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(beginReportAnalysis(database, 'resident', crypto.randomUUID(), { ...input, photoIds: [...input.photoIds].reverse() }, model))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(beginReportAnalysis(database, 'resident', crypto.randomUUID(), { ...input, pin: { lat: 49.15, lng: 9.22 } }, model))
        .rejects.toMatchObject({ code: 'PIN_TOO_FAR' });
      await pool.query("UPDATE report_photos SET upload_expires_at = clock_timestamp() - interval '25 hours'");
      await expect(beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model)).rejects.toMatchObject({ code: 'EXPIRED' });
      expect((await pool.query('SELECT count(*)::int AS n FROM ai_analyses')).rows[0].n).toBe(0);
    }));

  it('retries retained photos after natural analysis expiry with a fresh fix while old keys stay expired', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const key = crypto.randomUUID();
      const old = await beginReportAnalysis(database, 'resident', key, input, model);
      expect(await finishReportAnalysis(database, 'resident', old.analysisId, assessment)).toBe(true);
      await pool.query("UPDATE ai_analyses SET created_at = now() - interval '31 minutes', expires_at = now() - interval '1 second'");
      await pool.query("UPDATE analysis_leases SET lease_until = now() - interval '1 second'");
      await pool.query("UPDATE report_photos SET upload_expires_at = now() - interval '31 minutes'");
      const replay = await beginReportAnalysis(database, 'resident', key, input, model);
      expect(replay).toMatchObject({ analysisId: old.analysisId, started: false });
      await expect(readReportAnalysis(database, 'resident', old.analysisId, crypto.randomUUID()))
        .rejects.toMatchObject({ code: 'EXPIRED' });
      const next = await beginReportAnalysis(database, 'resident', crypto.randomUUID(), {
        ...input, measuredLocation: { ...input.measuredLocation, observedAt: new Date().toISOString() },
      }, model);
      expect(next.started).toBe(true);
      expect(next.analysisId).not.toBe(old.analysisId);
      expect(await finishReportAnalysis(database, 'resident', old.analysisId, assessment)).toBe(false);
      expect((await pool.query('SELECT state FROM report_photos')).rows[0].state).toBe('UPLOADED');
      expect((await pool.query('SELECT count(*)::int AS n FROM reward_ledger')).rows[0].n).toBe(0);
    }));

  it('does not let a crashed RUNNING attempt pin expired unattached photos forever', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      const ttl = await pool.query("SELECT extract(epoch FROM expires_at - clock_timestamp()) AS seconds FROM ai_analyses");
      expect(Number(ttl.rows[0].seconds)).toBeGreaterThan(40);
      expect(Number(ttl.rows[0].seconds)).toBeLessThanOrEqual(45);
      expect((await pool.query('SELECT a.expires_at = l.lease_until AS matching FROM ai_analyses a JOIN analysis_leases l ON a.id = l.current_analysis_id')).rows[0].matching).toBe(true);
      await pool.query("UPDATE ai_analyses SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second'");
      await pool.query("UPDATE report_photos SET upload_expires_at = now() - interval '25 hours'");
      const bucket = { delete: vi.fn(async () => {}) };
      expect(await removeExpiredPhotos(database, bucket)).toBe(1);
      expect(bucket.delete).toHaveBeenCalledTimes(1);
    }));
});

describe('report-analysis HTTP orchestration (real SQL; explicit R2/provider doubles)', () => {
  it('sends all five photos outside SQL transactions and polls a shared in-progress attempt', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool, 5);
      let insideTransaction = 0;
      const observedDatabase: TransactionDatabase = { withTransaction: (work) => database.withTransaction(async (client) => {
        insideTransaction++; try { return await work(client); } finally { insideTransaction--; }
      }) };
      let release!: () => void; let started!: () => void;
      const began = new Promise<void>((resolve) => { started = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(insideTransaction).toBe(0);
        const body = JSON.parse(String(init?.body));
        expect(body.contents[0].parts.filter((p: { inlineData?: unknown }) => p.inlineData)).toHaveLength(5);
        started(); await hold; return modelResponse();
      });
      const api = appFor(observedDatabase, fetcher);
      const first = api.start(input);
      try {
        await began;
        const duplicate = await api.start(input);
        expect(duplicate.status).toBe(202);
        const running = ReportAnalysisSchema.parse(await duplicate.json());
        expect(running.status).toBe('RUNNING');
        expect((await api.poll(running.analysisId)).status).toBe(200);
        expect((await api.poll(running.analysisId, 'other')).status).toBe(404);
        release();
        const response = await first;
        const ready = ReportAnalysisSchema.parse(await response.json());
        expect(ready).toMatchObject({ analysisId: running.analysisId, status: 'READY', result: assessment });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(api.get).toHaveBeenCalledTimes(5);
        expect((await pool.query('SELECT count(*)::int AS n FROM reports')).rows[0].n).toBe(0);
        expect((await pool.query('SELECT count(*)::int AS n FROM reward_ledger')).rows[0].n).toBe(0);
      } finally { release(); await first; }
    }));

  it('preserves RETAKE without a route and reuses READY on same-key retry without a second provider call', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const retake = { decision: 'RETAKE', reasonCode: 'INSUFFICIENT_EVIDENCE', reason: 'Blurred.', instruction: 'Retake a clear photo.' };
      const fetcher = vi.fn(async () => modelResponse(retake));
      const api = appFor(database, fetcher); const key = crypto.randomUUID();
      const response = await api.start(input, key);
      expect(await response.json()).toMatchObject({ status: 'READY', result: retake });
      const replay = await api.start(input, key);
      expect(await replay.json()).toMatchObject({ status: 'READY', result: retake });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }));

  it('stores safe FAILED on provider failure and retains uploaded photos for a new explicit attempt', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const fetcher = vi.fn(async () => { throw new Error('private provider/key detail'); });
      const api = appFor(database, fetcher);
      const response = await api.start(input);
      const body = ReportAnalysisSchema.parse(await response.json());
      expect(body.status).toBe('FAILED'); expect(JSON.stringify(body)).not.toContain('private provider');
      expect((await pool.query('SELECT state FROM report_photos')).rows[0].state).toBe('UPLOADED');
      expect((await pool.query('SELECT status,result FROM ai_analyses')).rows[0]).toEqual({ status: 'FAILED', result: null });
      expect(await (await api.poll(body.analysisId)).json()).toMatchObject({ status: 'FAILED' });
    }));

  it('rejects mismatched object bytes without calling Gemini or producing a usable result', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const api = appFor(database);
      const altered = jpeg.slice(); altered[0] = 0;
      api.get.mockResolvedValueOnce({ size: jpeg.length, arrayBuffer: async () => altered.buffer });
      const response = await api.start(input);
      expect(await response.json()).toMatchObject({ status: 'FAILED' });
      expect(api.fetcher).not.toHaveBeenCalled();
    }));

  it('bounds stalled object reads and releases the attempt as FAILED without a model call', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const api = appFor(database);
      let started!: () => void;
      const began = new Promise<void>((resolve) => { started = resolve; });
      api.get.mockImplementationOnce(() => { started(); return new Promise<never>(() => {}); });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = api.start(input);
      try {
        await began;
        await vi.advanceTimersByTimeAsync(10_001);
        const response = await pending;
        expect(await response.json()).toMatchObject({ status: 'FAILED' });
        expect(api.fetcher).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    }));
});

describe('cleanup-analysis HTTP safety (real SQL; explicit R2/provider/auth doubles)', () => {
  async function expectNoCleanupEffects(pool: Pool, input: { reportId: string; photoIds: string[] }) {
    expect((await pool.query('SELECT status FROM reports WHERE id = $1', [input.reportId])).rows[0].status).toBe('VERIFIED');
    expect((await pool.query('SELECT state, cleanup_id FROM report_photos WHERE id = ANY($1::uuid[])', [input.photoIds])).rows)
      .toEqual(input.photoIds.map(() => ({ state: 'UPLOADED', cleanup_id: null })));
    expect((await pool.query('SELECT count(*)::int AS n FROM cleanup_submissions')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM reward_ledger')).rows[0].n).toBe(0);
  }

  it('compares all five before/after photos outside SQL, replays once, and attaches only on explicit submission', () =>
    withTestDatabase(async (pool) => {
      const { database, input, objects, beforeBytes } = await prepareCleanup(pool, 5);
      let insideTransaction = 0;
      const observedDatabase: TransactionDatabase = { withTransaction: (work) => database.withTransaction(async (client) => {
        insideTransaction++; try { return await work(client); } finally { insideTransaction--; }
      }) };
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(insideTransaction).toBe(0);
        const body = JSON.parse(String(init?.body));
        const images = body.contents[0].parts.filter((part: { inlineData?: unknown }) => part.inlineData)
          .map((part: { inlineData: { data: string } }) => part.inlineData.data);
        expect(images).toEqual([
          ...Array(5).fill(Buffer.from(beforeBytes).toString('base64')),
          ...Array(5).fill(Buffer.from(jpeg).toString('base64')),
        ]);
        expect(body.systemInstruction.parts[0].text).toContain('Deutsch');
        return modelResponse(cleanupAssessment);
      });
      const api = appFor(observedDatabase, fetcher, objects);
      const key = crypto.randomUUID();
      const response = await api.startCleanup(input, key);
      expect(response.status).toBe(202);
      const ready = CleanupAnalysisSchema.parse(await response.json());
      expect(ready).toMatchObject({ status: 'READY', result: cleanupAssessment });
      expect(await (await api.startCleanup(input, key)).json()).toEqual(ready);
      expect(api.get).toHaveBeenCalledTimes(10);
      expect(api.get.mock.calls.map(([key]) => key)).toEqual([
        ...[...objects.keys()].slice(5), ...input.photoIds.map((id) => 'photos/' + id),
      ]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await api.poll(ready.analysisId, 'other')).status).toBe(404);
      expect(await (await api.poll(ready.analysisId)).json()).toEqual(ready);
      await expectNoCleanupEffects(pool, input);

      const service = new PostgresCleanupSubmissionService(database,
        createReportMediaResolver('https://iskra.test', 'test-only-signing-key-at-least-32-bytes'));
      const submitted = await service.submit('resident', crypto.randomUUID(), input.reportId, { analysisId: ready.analysisId });
      expect(submitted.receipt.report.status).toBe('AWAITING_RESOLUTION');
      expect((await pool.query('SELECT state, cleanup_id FROM report_photos WHERE id = ANY($1::uuid[])', [input.photoIds])).rows)
        .toEqual(input.photoIds.map(() => ({ state: 'ATTACHED', cleanup_id: submitted.receipt.cleanupId })));
      expect((await pool.query('SELECT count(*)::int AS n FROM reward_ledger')).rows[0].n).toBe(0);
      expect((await api.poll(ready.analysisId)).status).toBe(410);
    }));

  it.each(['provider quota', 'network failure', 'unsafe output'] as const)(
    'keeps %s unpublishable, redacts details, and retries retained photos only with a fresh key', (failure) =>
      withTestDatabase(async (pool) => {
        const { database, input, objects } = await prepareCleanup(pool);
        const fetcher = vi.fn(async () => {
          if (failure === 'provider quota') return new Response('private-provider-detail', { status: 429 });
          if (failure === 'network failure') throw new Error('private-provider-detail');
          return modelResponse({ ...cleanupAssessment, hazardRemaining: true });
        });
        const api = appFor(database, fetcher, objects);
        const key = crypto.randomUUID();
        const response = await api.startCleanup(input, key);
        expect(response.status).toBe(202);
        const failed = CleanupAnalysisSchema.parse(await response.json());
        expect(failed).toMatchObject({ status: 'FAILED', error: { code: 'AI_UNAVAILABLE', retryable: true } });
        expect(JSON.stringify(failed)).not.toContain('private-provider-detail');
        expect((await pool.query("SELECT status, result FROM ai_analyses WHERE kind = 'CLEANUP'")).rows)
          .toEqual([{ status: 'FAILED', result: null }]);
        const service = new PostgresCleanupSubmissionService(database,
          createReportMediaResolver('https://iskra.test', 'test-only-signing-key-at-least-32-bytes'));
        await expect(service.submit('resident', crypto.randomUUID(), input.reportId, { analysisId: failed.analysisId }))
          .rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
        await expectNoCleanupEffects(pool, input);
        expect(await (await api.startCleanup(input, key)).json()).toMatchObject({ analysisId: failed.analysisId, status: 'FAILED' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect((await api.poll(failed.analysisId, 'other')).status).toBe(404);

        fetcher.mockImplementation(async () => modelResponse(cleanupAssessment));
        const recovered = CleanupAnalysisSchema.parse(await (await api.startCleanup(input)).json());
        expect(recovered).toMatchObject({ status: 'READY', result: cleanupAssessment });
        expect(recovered.analysisId).not.toBe(failed.analysisId);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(await (await api.poll(failed.analysisId)).json()).toMatchObject({ status: 'FAILED' });
        await expectNoCleanupEffects(pool, input);
      }));

  it.each(['before read fails', 'after hash differs'] as const)(
    'does not call Vertex or attach evidence when %s', (failure) => withTestDatabase(async (pool) => {
      const { database, input, objects } = await prepareCleanup(pool);
      const fetcher = vi.fn(async () => modelResponse(cleanupAssessment));
      const api = appFor(database, fetcher, objects);
      if (failure === 'before read fails') api.get.mockRejectedValueOnce(new Error('private-storage-detail'));
      else {
        const altered = jpeg.slice(); altered[0] = 0;
        objects.set('photos/' + input.photoIds[0], altered);
      }
      const response = await api.startCleanup(input);
      expect(response.status).toBe(202);
      const failed = CleanupAnalysisSchema.parse(await response.json());
      expect(failed).toMatchObject({ status: 'FAILED', error: { retryable: true } });
      expect(JSON.stringify(failed)).not.toContain('private-storage-detail');
      expect(fetcher).not.toHaveBeenCalled();
      expect((await pool.query("SELECT status, result FROM ai_analyses WHERE kind = 'CLEANUP'")).rows)
        .toEqual([{ status: 'FAILED', result: null }]);
      await expectNoCleanupEffects(pool, input);
    }));

  it('rejects foreign after-photos and stale or distant GPS before storage, model calls or idempotency claims', () =>
    withTestDatabase(async (pool) => {
      const { database, input, objects } = await prepareCleanup(pool);
      const api = appFor(database, vi.fn(async () => modelResponse(cleanupAssessment)), objects);
      const foreign = await api.startCleanup(input, crypto.randomUUID(), 'other');
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      for (const [location, status, code] of [
        [{ ...input.location, observedAt: new Date(Date.now() - 120_000).toISOString() }, 422, 'LOCATION_STALE'],
        [{ ...input.location, lat: 50 }, 403, 'TOO_FAR'],
      ] as const) {
        const response = await api.startCleanup({ ...input, location });
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ error: { code } });
      }
      expect(api.get).not.toHaveBeenCalled();
      expect(api.fetcher).not.toHaveBeenCalled();
      expect((await pool.query("SELECT count(*)::int AS n FROM ai_analyses WHERE kind = 'CLEANUP'")).rows[0].n).toBe(0);
      expect((await pool.query('SELECT count(*)::int AS n FROM idempotency_keys')).rows[0].n).toBe(0);
      await expectNoCleanupEffects(pool, input);
    }));
});
