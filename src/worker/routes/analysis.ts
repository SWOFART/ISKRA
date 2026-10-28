import { Hono } from 'hono';
import { ReportAnalysisRequestSchema, ReportAnalysisSchema, UuidSchema } from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import { beginReportAnalysis, evidenceQuota, finishReportAnalysis, readReportAnalysis, type AnalysisPhoto } from '../db/evidence-store';
import { requireAuth, verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { parseJsonBody } from '../middleware/validation';
import { analyzeReport, validateGeminiConfig } from '../services/gemini';
import { validateJpeg } from '../services/media';

async function loadReportBytes(bucket: R2Bucket, photos: AnalysisPhoto[]) {
  const reads = Promise.all(photos.map(async (photo) => {
    const object = await bucket.get(photo.object_key);
    if (!object || object.size !== photo.byte_size) throw new Error('Unavailable photo');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== photo.byte_size) throw new Error('Inconsistent photo');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== photo.sha256) throw new Error('Inconsistent photo');
    validateJpeg(bytes, 'image/jpeg');
    return bytes;
  }));
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([reads, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Photo read timed out')), 10_000);
    })]);
  } catch {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'Analysis photos are temporarily unavailable.');
  } finally { clearTimeout(timer!); }
}

export function createAnalysisRoutes({ database, verify, now = Date.now, fetcher = fetch }: {
  database?: TransactionDatabase; verify?: typeof verifyFirebaseToken; now?: () => number; fetcher?: typeof fetch;
} = {}) {
  const routes = new Hono<WorkerEnv>();
  routes.post('/ai/analyze-report', requireAuth(verify), async (c) => {
    const limit = evidenceQuota(c.env.AI_RATE_PER_MINUTE, 5);
    if (limit === 0) throw new ApiError(503, 'UNAVAILABLE', 'Analysis is temporarily paused.', true);
    const key = UuidSchema.safeParse(c.req.header('Idempotency-Key'));
    if (!key.success) throw new ApiError(400, 'INVALID_INPUT', 'Provide a valid analysis operation key.');
    const parsed = await parseJsonBody(c, ReportAnalysisRequestSchema);
    const input = { ...parsed, photoIds: parsed.photoIds.map((id) => id.toLowerCase()) };
    if (!database || !c.env.PHOTOS) throw new ApiError(503, 'UNAVAILABLE', 'Analysis storage is not configured.');
    const config = { authJson: c.env.VERTEX_AUTH_JSON ?? '', modelId: c.env.GEMINI_MODEL_ID ?? '' };
    validateGeminiConfig(config);
    const uid = c.get('identity')!.uid;
    const work = await beginReportAnalysis(database, uid, key.data.toLowerCase(), input, config.modelId, now, limit);
    if (work.started) {
      try {
        const photos = await loadReportBytes(c.env.PHOTOS, work.photos);
        const result = await analyzeReport(config, {
          comment: input.comment, outputLocale: input.outputLocale, photos,
        }, fetcher);
        await finishReportAnalysis(database, uid, work.analysisId, result);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        await finishReportAnalysis(database, uid, work.analysisId, null);
      }
    }
    return c.json(ReportAnalysisSchema.parse(await readReportAnalysis(database, uid, work.analysisId, c.get('requestId'))), 202);
  });
  routes.get('/ai/analyses/:id', requireAuth(verify), async (c) => {
    const id = UuidSchema.safeParse(c.req.param('id'));
    if (!id.success || new URL(c.req.url).search) throw new ApiError(400, 'INVALID_INPUT', 'Invalid analysis lookup.');
    if (!database) throw new ApiError(503, 'UNAVAILABLE', 'Analysis storage is not configured.');
    return c.json(ReportAnalysisSchema.parse(await readReportAnalysis(database, c.get('identity')!.uid, id.data, c.get('requestId'))));
  });
  routes.post('/ai/analyze-cleanup', requireAuth(verify), () => {
    throw new ApiError(503, 'UNAVAILABLE', 'Cleanup analysis awaits durable upload target binding.');
  });
  return routes;
}
