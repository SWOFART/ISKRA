import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportAnalysisSchema } from '../../../src/shared/contracts';
import { PostgresTransactionDatabase, type TransactionDatabase } from '../../../src/worker/db/client';
import { beginReportAnalysis, finishReportAnalysis, readReportAnalysis, removeExpiredPhotos } from '../../../src/worker/db/evidence-store';
import { createApp } from '../../../src/worker/index';
import { withTestDatabase } from '../auth/postgres';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const jpeg = new Uint8Array(await readFile(new URL('../../fixtures/photos/grayscale.jpg', import.meta.url)));
const hash = Buffer.from(await crypto.subtle.digest('SHA-256', jpeg)).toString('hex');
const assessment = { decision: 'ACCEPT', route: 'GREEN', description: 'Litter beside a path.', hazardLevel: 'NONE',
  safetyMessage: '', reason: 'Small visible litter.', confidence: 0.8 } as const;
const model = 'test-only-model';

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

function appFor(database: TransactionDatabase, fetcher = vi.fn(async () => modelResponse())) {
  vi.stubGlobal('fetch', fetcher);
  const app = createApp({ database, verify: async (token) => ({ uid: token }) });
  const get = vi.fn(async () => ({ size: jpeg.length, arrayBuffer: async () => jpeg.slice().buffer }));
  const env = { FIREBASE_PROJECT_ID: 'iskra-test', GEMINI_API_KEY: 'test-only-key', GEMINI_MODEL_ID: model,
    PHOTOS: { get } as unknown as R2Bucket };
  const start = (input: unknown, key = crypto.randomUUID(), uid = 'resident') => app.request('https://iskra.test/api/ai/analyze-report', {
    method: 'POST', headers: { Authorization: 'Bearer ' + uid, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(input),
  }, env);
  const poll = (id: string, uid = 'resident') => app.request('https://iskra.test/api/ai/analyses/' + id, {
    headers: { Authorization: 'Bearer ' + uid },
  }, env);
  return { app, env, get, start, poll, fetcher };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('SQL report-analysis attempts and leases', () => {
  it('shares active identical work across concurrent keys and resolves same-key replay before stale-location admission', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      const keys = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      const results = await Promise.all(keys.map((key) => beginReportAnalysis(database, 'resident', key, input, model)));
      expect(new Set(results.map((v) => v.analysisId)).size).toBe(1);
      expect(results.filter((v) => v.started)).toHaveLength(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM ai_analyses')).rows[0].n).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM analysis_leases')).rows[0].n).toBe(1);
      const replay = await beginReportAnalysis(database, 'resident', keys[0], input, model, Date.now() + 120_000);
      expect(replay).toMatchObject({ analysisId: results[0].analysisId, started: false });
      await expect(beginReportAnalysis(database, 'resident', keys[0], { ...input, comment: 'Changed' }, model))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await expect(beginReportAnalysis(database, 'resident', crypto.randomUUID(), { ...input, comment: 'New' }, model, Date.now() + 120_000))
        .rejects.toMatchObject({ code: 'LOCATION_STALE' });
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

  it('rejects foreign, incorrectly ordered, expired, moved-pin and stale evidence before starting work', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool, 2);
      await expect(beginReportAnalysis(database, 'other', crypto.randomUUID(), input, model)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(beginReportAnalysis(database, 'resident', crypto.randomUUID(), { ...input, photoIds: [...input.photoIds].reverse() }, model))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(beginReportAnalysis(database, 'resident', crypto.randomUUID(), { ...input, pin: { lat: 49.15, lng: 9.22 } }, model))
        .rejects.toMatchObject({ code: 'PIN_TOO_FAR' });
      await pool.query("UPDATE report_photos SET upload_expires_at = clock_timestamp() - interval '1 second'");
      await expect(beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model)).rejects.toMatchObject({ code: 'EXPIRED' });
      expect((await pool.query('SELECT count(*)::int AS n FROM ai_analyses')).rows[0].n).toBe(0);
    }));

  it('does not let a crashed RUNNING attempt pin expired unattached photos forever', () =>
    withTestDatabase(async (pool) => {
      const { database, input } = await prepare(pool);
      await beginReportAnalysis(database, 'resident', crypto.randomUUID(), input, model);
      const ttl = await pool.query("SELECT extract(epoch FROM expires_at - clock_timestamp()) AS seconds FROM ai_analyses");
      expect(Number(ttl.rows[0].seconds)).toBeGreaterThan(40);
      expect(Number(ttl.rows[0].seconds)).toBeLessThanOrEqual(45);
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
      const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
        expect(insideTransaction).toBe(0);
        const body = JSON.parse(String(init.body));
        expect(body.contents[0].parts.filter((p: { inlineData?: unknown }) => p.inlineData)).toHaveLength(5);
        started(); await hold; return modelResponse();
      });
      const api = appFor(observedDatabase, fetcher as never);
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
