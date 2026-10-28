import { API_ERROR_POLICY, CleanupAnalysisRequestSchema, CleanupAssessmentSchema, POLICY,
  ReportAnalysisContextSchema, ReportAssessmentSchema,
  type ReportAnalysisRequestSchema, type UploadRequestSchema } from '../../shared/contracts';
import type { Infer } from '../../shared/schema';
import { distanceM, reportPinAdmission } from '../../shared/location';
import { hashBeforeEvidence } from '../services/report-context';
import { executeIdempotently, IdempotencyConflictError, type CheckedOutClient, type TransactionDatabase } from './client';
import { ApiError } from '../middleware/errors';

/** ponytail: one UID/minute cap from AI_RATE_PER_MINUTE. 0 pauses AI and uploads. Per-IP caps need a new table. */
export function evidenceQuota(raw: string | undefined, fallback: number) {
  if (raw == null || raw === '') return fallback;
  if (!/^\d{1,2}$/.test(raw)) throw new ApiError(503, 'UNAVAILABLE', 'Evidence quota is not configured.', true);
  return Number(raw);
}

async function rejectUploadBurst(client: CheckedOutClient, uid: string, limit: number) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('iskra:upload:' || $1::text, 0))", [uid]);
  const recent = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM report_photos
     WHERE owner_user_id = $1 AND created_at > clock_timestamp() - interval '1 minute'`, [uid],
  );
  if (recent.rows[0].count >= limit) {
    throw new ApiError(429, 'RATE_LIMITED', 'Wait a minute before uploading another photo.');
  }
}

/** Checked again inside finalization. A concurrent overflow can still leave one unusable object. */
export async function assertUploadRate(database: TransactionDatabase, uid: string, limit: number) {
  if (limit === 0) throw new ApiError(503, 'UNAVAILABLE', 'Photo uploads are temporarily paused.', true);
  await database.withTransaction((client) => rejectUploadBurst(client, uid, limit));
}

/** Read admission only: a ticket does not claim a cleanup or create usable evidence. */
export async function admitUpload(
  database: TransactionDatabase,
  uid: string,
  request: Infer<typeof UploadRequestSchema>,
  photoId?: string,
): Promise<void> {
  await database.withTransaction(async (client) => {
    const user = await client.query('SELECT id FROM users WHERE id = $1', [uid]);
    if (!user.rows.length) {
      throw new ApiError(403, 'NOT_ELIGIBLE', 'Complete account setup before uploading photos.');
    }
    if (request.purpose === 'CLEANUP') {
      const report = await client.query<{ route: string; status: string }>(
        'SELECT route, status FROM reports WHERE id = $1', [request.reportId],
      );
      const target = report.rows[0];
      if (!target) throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
      if (target.route !== 'GREEN' || target.status !== 'VERIFIED') {
        throw new ApiError(403, 'NOT_ELIGIBLE', 'This report cannot accept cleanup evidence.');
      }
    }
    if (photoId) {
      const photo = await client.query('SELECT id FROM report_photos WHERE id = $1', [photoId]);
      if (photo.rows.length) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This photo ID has already been used.');
      }
    }
  });
}

/** Storage first: a rolled-back SQL insert leaves an object that cannot be used as evidence. */
export async function finalizeReportPhoto(database: TransactionDatabase, photo: {
  uid: string; photoId: string; objectKey: string; byteSize: number; sha256: string;
  ordinal: number; expiresAt: string; purpose?: 'REPORT' | 'CLEANUP';
}, limit = 10) {
  if (limit === 0) throw new ApiError(503, 'UNAVAILABLE', 'Photo uploads are temporarily paused.', true);
  const purpose = photo.purpose === 'CLEANUP' ? 'CLEANUP' : 'REPORT';
  await database.withTransaction(async (client) => {
    await rejectUploadBurst(client, photo.uid, limit);
    const result = await client.query(
      `INSERT INTO report_photos (id, owner_user_id, purpose, state, object_key, ordinal,
         mime_type, byte_size, sha256, upload_expires_at)
       SELECT $1::uuid, $2, '${purpose}', 'UPLOADED', $3, $4, 'image/jpeg', $5, $6, $7::timestamptz
       WHERE clock_timestamp() < $7::timestamptz
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [photo.photoId, photo.uid, photo.objectKey, photo.ordinal - 1, photo.byteSize, photo.sha256, photo.expiresAt],
    );
    if (!result.rows.length) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This photo ID has already been used.');
    }
  });
}

export interface StoredPhoto extends Record<string, unknown> {
  id: string;
  owner_user_id: string;
  object_key: string;
  byte_size: number;
  state: 'RESERVED' | 'UPLOADED' | 'ATTACHED';
  published: boolean;
}

export async function readPhoto(database: TransactionDatabase, photoId: string) {
  return database.withTransaction(async (client) => {
    const result = await client.query<StoredPhoto>(
      `SELECT p.id, p.owner_user_id, p.object_key, p.byte_size, p.state,
         (p.state = 'ATTACHED' AND (r.id IS NOT NULL OR parent.id IS NOT NULL)) AS published
       FROM report_photos p
       LEFT JOIN reports r ON p.purpose = 'REPORT' AND r.id = p.report_id
       LEFT JOIN cleanup_submissions cleanup ON p.purpose = 'CLEANUP' AND cleanup.id = p.cleanup_id
       LEFT JOIN reports parent ON parent.id = cleanup.report_id
       WHERE p.id = $1::uuid`, [photoId],
    );
    return result.rows[0] ?? null;
  });
}

/** Operator/scheduler only: retain expired unattached evidence for at least 24 hours. */
export async function removeExpiredPhotos(database: TransactionDatabase, bucket: Pick<R2Bucket, 'delete'>) {
  return database.withTransaction(async (client) => {
    const result = await client.query<{ id: string; object_key: string }>(
      `SELECT p.id, p.object_key FROM report_photos p
       WHERE p.state IN ('RESERVED', 'UPLOADED') AND p.report_id IS NULL AND p.cleanup_id IS NULL
         AND p.upload_expires_at < clock_timestamp() - interval '24 hours'
         AND NOT EXISTS (
           SELECT 1 FROM ai_analyses a WHERE a.photo_ids ? p.id::text
             AND a.status IN ('RUNNING', 'READY') AND a.consumed_at IS NULL
             AND (a.expires_at IS NULL OR a.expires_at > clock_timestamp())
         )
       ORDER BY p.upload_expires_at, p.id LIMIT 25 FOR UPDATE OF p SKIP LOCKED`,
    );
    // Hold photo locks through object deletion so attachment cannot race housekeeping.
    for (const photo of result.rows) {
      try { await bucket.delete(photo.object_key); }
      catch { throw new ApiError(503, 'UNAVAILABLE', 'Photo cleanup is temporarily unavailable.'); }
      await client.query('DELETE FROM report_photos WHERE id = $1::uuid', [photo.id]);
    }
    return result.rows.length;
  });
}

type ReportInput = Infer<typeof ReportAnalysisRequestSchema>;
export interface AnalysisPhoto extends Record<string, unknown> {
  id: string; owner_user_id: string; purpose: string; state: string;
  report_id: string | null; cleanup_id: string | null; ordinal: number;
  object_key: string; byte_size: number; sha256: string; retained: boolean;
}
interface AnalysisAttempt extends Record<string, unknown> {
  id: string; kind: string; status: string; result: unknown; expires_at: Date | string | null;
  consumed_at: Date | string | null; current_attempt: boolean; lease_active: boolean; unexpired: boolean;
}

async function digest(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function reportInputPhotos(client: CheckedOutClient, uid: string, ids: string[], lock = false) {
  const result = await client.query<AnalysisPhoto>(
    `SELECT id, owner_user_id, purpose, state, report_id, cleanup_id, ordinal, object_key, byte_size, sha256,
       upload_expires_at > clock_timestamp() - interval '24 hours' AS retained
     FROM report_photos WHERE id = ANY($1::uuid[]) ORDER BY id ${lock ? 'FOR SHARE' : ''}`, [ids],
  );
  const photos = ids.map((id) => result.rows.find((row) => row.id === id));
  if (photos.some((photo, index) => !photo || photo.owner_user_id !== uid || photo.purpose !== 'REPORT'
    || photo.state !== 'UPLOADED' || photo.report_id !== null || photo.cleanup_id !== null || photo.ordinal !== index)) {
    throw new ApiError(403, 'FORBIDDEN', 'Provide your own unused report photos in capture order.');
  }
  return photos as AnalysisPhoto[];
}

/** Claims/reuses SQL work only. No model or object transfer is allowed inside this transaction. */
export async function beginReportAnalysis(
  database: TransactionDatabase, uid: string, key: string, input: ReportInput, modelId: string, now = Date.now,
  limit = 5,
) {
  if (limit === 0) throw new ApiError(503, 'UNAVAILABLE', 'Analysis is temporarily paused.', true);
  const account = await database.withTransaction((client) => client.query('SELECT id FROM users WHERE id = $1', [uid]));
  if (!account.rows.length) throw new ApiError(403, 'NOT_ELIGIBLE', 'Complete account setup before analysis.');
  try {
    const execution = await executeIdempotently(database, {
      actorId: uid, operation: 'REPORT_ANALYSIS', key, requestHash: await digest(input),
    }, async (client) => {
      // Serialize this UID's attempt admissions across Worker instances, including the rate check.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('iskra:analysis:' || $1::text, 0))", [uid]);
      const photos = await reportInputPhotos(client, uid, input.photoIds);
      const context = ReportAnalysisContextSchema.parse({
        comment: input.comment, measuredLocation: input.measuredLocation, pin: input.pin,
        cityId: input.cityId, outputLocale: input.outputLocale,
      });
      const inputHash = await digest({ context, photos: photos.map((photo) => [photo.id, photo.ordinal, photo.sha256]) });
      const lease = await client.query<{ current_analysis_id: string; active: boolean }>(
        `SELECT current_analysis_id, lease_until > clock_timestamp() AS active
         FROM analysis_leases WHERE owner_user_id = $1 AND kind = 'REPORT' AND input_hash = $2
         FOR UPDATE`, [uid, inputHash],
      );
      const slot = lease.rows[0];
      const current = slot ? await client.query<{ status: string; unexpired: boolean; consumed_at: unknown }>(
        `SELECT status, expires_at > clock_timestamp() AS unexpired, consumed_at FROM ai_analyses
         WHERE id = $1::uuid FOR UPDATE`, [slot.current_analysis_id],
      ) : null;
      const previous = slot && current?.rows[0] ? { ...slot, ...current.rows[0] } : undefined;
      let analysisId = previous?.current_analysis_id;
      const shared = previous && previous.consumed_at === null && previous.active && previous.unexpired
        && ['RUNNING', 'READY'].includes(previous.status);
      if (!shared) {
        // Lock lease before photos, matching publication's lock order.
        const lockedPhotos = await reportInputPhotos(client, uid, input.photoIds, true);
        // New work uses the existing orphan-retention window, not the expired PUT capability.
        if (lockedPhotos.some((photo) => !photo.retained)) {
          throw new ApiError(410, 'EXPIRED', 'One or more report photos have expired.');
        }
        const count = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ai_analyses
           WHERE owner_user_id = $1 AND created_at > clock_timestamp() - interval '1 minute'`, [uid],
        );
        if (count.rows[0].count >= limit) throw new ApiError(429, 'RATE_LIMITED', 'Wait a minute before starting another analysis.');
        const rejection = reportPinAdmission(input.measuredLocation, input.pin, now());
        if (rejection) throw new ApiError(API_ERROR_POLICY[rejection].httpStatus, rejection, 'Acquire a fresh accurate location and keep the pin within 3 metres.');
        analysisId = crypto.randomUUID();
        await client.query(
          `INSERT INTO ai_analyses (id, owner_user_id, kind, status, input_hash, photo_ids, context, model_id, prompt_version, expires_at)
           VALUES ($1::uuid, $2, 'REPORT', 'RUNNING', $3, $4::jsonb, $5::jsonb, $6, 'report-v1', clock_timestamp() + interval '45 seconds')`,
          [analysisId, uid, inputHash, JSON.stringify(input.photoIds), JSON.stringify(context), modelId],
        );
        await client.query(
          `INSERT INTO analysis_leases (owner_user_id, kind, input_hash, current_analysis_id, lease_until)
           SELECT owner_user_id, kind, input_hash, id, expires_at FROM ai_analyses WHERE id = $1::uuid
           ON CONFLICT (owner_user_id, kind, input_hash) DO UPDATE
           SET current_analysis_id = EXCLUDED.current_analysis_id, lease_until = EXCLUDED.lease_until,
               updated_at = clock_timestamp()`, [analysisId],
        );
      }
      return {
        value: { analysisId: analysisId!, started: !shared, photos },
        receipt: { resourceId: analysisId!, responseStatus: 202 },
      };
    }, async (_client, receipt) => ({ analysisId: receipt.resourceId, started: false, photos: [] as AnalysisPhoto[] }));
    return execution.value;
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key belongs to different analysis inputs.');
    }
    throw error;
  }
}

type CleanupInput = Infer<typeof CleanupAnalysisRequestSchema>;

async function cleanupInputPhotos(client: CheckedOutClient, uid: string, ids: string[], lock = false) {
  const result = await client.query<AnalysisPhoto>(
    `SELECT id, owner_user_id, purpose, state, report_id, cleanup_id, ordinal, object_key, byte_size, sha256,
       upload_expires_at > clock_timestamp() - interval '24 hours' AS retained
     FROM report_photos WHERE id = ANY($1::uuid[]) ORDER BY id ${lock ? 'FOR SHARE' : ''}`, [ids],
  );
  const photos = ids.map((id) => result.rows.find((row) => row.id === id));
  if (photos.some((photo, index) => !photo || photo.owner_user_id !== uid || photo.purpose !== 'CLEANUP'
    || photo.state !== 'UPLOADED' || photo.report_id !== null || photo.cleanup_id !== null || photo.ordinal !== index)) {
    throw new ApiError(403, 'FORBIDDEN', 'Provide your own unused cleanup photos in capture order.');
  }
  return photos as AnalysisPhoto[];
}

/** Binds after-photos to the verified GREEN report B's submission already requires. No model call inside SQL. */
export async function beginCleanupAnalysis(
  database: TransactionDatabase, uid: string, key: string, input: CleanupInput, modelId: string, now = Date.now,
  limit = 5,
) {
  if (limit === 0) throw new ApiError(503, 'UNAVAILABLE', 'Analysis is temporarily paused.', true);
  const request = CleanupAnalysisRequestSchema.parse({ ...input, photoIds: input.photoIds.map((id) => id.toLowerCase()),
    reportId: input.reportId.toLowerCase() });
  const account = await database.withTransaction((client) => client.query('SELECT id FROM users WHERE id = $1', [uid]));
  if (!account.rows.length) throw new ApiError(403, 'NOT_ELIGIBLE', 'Complete account setup before analysis.');
  try {
    const execution = await executeIdempotently(database, {
      actorId: uid, operation: 'CLEANUP_ANALYSIS', key, requestHash: await digest(request),
    }, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('iskra:analysis:' || $1::text, 0))", [uid]);
      const report = await client.query<{ id: string; description: string; lat: number; lng: number }>(
        `SELECT id, description, lat, lng FROM reports
         WHERE id = $1::uuid AND route = 'GREEN' AND status = 'VERIFIED' AND is_demo = false`,
        [request.reportId],
      );
      const target = report.rows[0];
      if (!target) throw new ApiError(403, 'NOT_ELIGIBLE', 'This report cannot accept cleanup evidence.');
      const observedAt = Date.parse(request.location.observedAt);
      if (observedAt > now() || now() - observedAt > POLICY.maxLocationAgeSeconds * 1000) {
        throw new ApiError(422, 'LOCATION_STALE', 'Acquire a fresh cleanup location.', true);
      }
      if (distanceM(request.location, { lat: Number(target.lat), lng: Number(target.lng) }) > POLICY.cleanupRadiusM) {
        throw new ApiError(403, 'TOO_FAR', 'The cleanup location must be within 150 metres of the report.', true);
      }
      const beforeRows = await client.query<AnalysisPhoto>(
        `SELECT id, ordinal, sha256, object_key, byte_size, owner_user_id, purpose, state, report_id, cleanup_id,
           true AS retained
         FROM report_photos WHERE report_id = $1::uuid AND purpose = 'REPORT' AND state = 'ATTACHED'
         ORDER BY ordinal`, [target.id],
      );
      if (beforeRows.rows.length < 1 || beforeRows.rows.length > 5
        || beforeRows.rows.some((photo, index) => photo.ordinal !== index)) {
        throw new ApiError(409, 'ANALYSIS_CONSUMED', 'The report evidence can no longer be compared.');
      }
      const beforeEvidenceHash = await hashBeforeEvidence(beforeRows.rows.map((photo) => ({
        id: photo.id, ordinal: photo.ordinal, sha256: photo.sha256,
      })));
      const context = {
        reportId: target.id, beforeEvidenceHash, location: request.location, outputLocale: request.outputLocale,
        description: target.description,
      };
      const after = await cleanupInputPhotos(client, uid, request.photoIds);
      const inputHash = await digest({
        context, photos: after.map((photo) => [photo.id, photo.ordinal, photo.sha256]),
      });
      const lease = await client.query<{ current_analysis_id: string; active: boolean }>(
        `SELECT current_analysis_id, lease_until > clock_timestamp() AS active
         FROM analysis_leases WHERE owner_user_id = $1 AND kind = 'CLEANUP' AND input_hash = $2
         FOR UPDATE`, [uid, inputHash],
      );
      const slot = lease.rows[0];
      const current = slot ? await client.query<{ status: string; unexpired: boolean; consumed_at: unknown }>(
        `SELECT status, expires_at > clock_timestamp() AS unexpired, consumed_at FROM ai_analyses
         WHERE id = $1::uuid FOR UPDATE`, [slot.current_analysis_id],
      ) : null;
      const previous = slot && current?.rows[0] ? { ...slot, ...current.rows[0] } : undefined;
      let analysisId = previous?.current_analysis_id;
      const shared = previous && previous.consumed_at === null && previous.active && previous.unexpired
        && ['RUNNING', 'READY'].includes(previous.status);
      let before = beforeRows.rows;
      if (!shared) {
        const lockedAfter = await cleanupInputPhotos(client, uid, request.photoIds, true);
        if (lockedAfter.some((photo) => !photo.retained)) {
          throw new ApiError(410, 'EXPIRED', 'One or more cleanup photos have expired.');
        }
        before = (await client.query<AnalysisPhoto>(
          `SELECT id, ordinal, sha256, object_key, byte_size, owner_user_id, purpose, state, report_id, cleanup_id,
             true AS retained
           FROM report_photos WHERE report_id = $1::uuid AND purpose = 'REPORT' AND state = 'ATTACHED'
           ORDER BY ordinal FOR SHARE`, [target.id],
        )).rows;
        const lockedHash = await hashBeforeEvidence(before.map((photo) => ({
          id: photo.id, ordinal: photo.ordinal, sha256: photo.sha256,
        })));
        if (lockedHash !== beforeEvidenceHash) {
          throw new ApiError(409, 'ANALYSIS_CONSUMED', 'The report evidence changed before analysis started.');
        }
        const count = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ai_analyses
           WHERE owner_user_id = $1 AND created_at > clock_timestamp() - interval '1 minute'`, [uid],
        );
        if (count.rows[0].count >= limit) throw new ApiError(429, 'RATE_LIMITED', 'Wait a minute before starting another analysis.');
        analysisId = crypto.randomUUID();
        await client.query(
          `INSERT INTO ai_analyses (id, owner_user_id, kind, status, report_id, input_hash, photo_ids, context, model_id, prompt_version, expires_at)
           VALUES ($1::uuid, $2, 'CLEANUP', 'RUNNING', $3::uuid, $4, $5::jsonb, $6::jsonb, $7, 'cleanup-v1', clock_timestamp() + interval '45 seconds')`,
          [analysisId, uid, target.id, inputHash, JSON.stringify(request.photoIds), JSON.stringify(context), modelId],
        );
        await client.query(
          `INSERT INTO analysis_leases (owner_user_id, kind, input_hash, current_analysis_id, lease_until)
           SELECT owner_user_id, kind, input_hash, id, expires_at FROM ai_analyses WHERE id = $1::uuid
           ON CONFLICT (owner_user_id, kind, input_hash) DO UPDATE
           SET current_analysis_id = EXCLUDED.current_analysis_id, lease_until = EXCLUDED.lease_until,
               updated_at = clock_timestamp()`, [analysisId],
        );
        return {
          value: { analysisId, started: true, photos: lockedAfter, before, description: target.description, outputLocale: request.outputLocale },
          receipt: { resourceId: analysisId, responseStatus: 202 },
        };
      }
      return {
        value: { analysisId: analysisId!, started: false, photos: after, before, description: target.description, outputLocale: request.outputLocale },
        receipt: { resourceId: analysisId!, responseStatus: 202 },
      };
    }, async (_client, receipt) => ({
      analysisId: receipt.resourceId, started: false, photos: [] as AnalysisPhoto[], before: [] as AnalysisPhoto[],
      description: '', outputLocale: 'en' as const,
    }));
    return execution.value;
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key belongs to different analysis inputs.');
    }
    throw error;
  }
}

/** Accept a provider completion only while its original SQL lease still owns live work. */
export async function finishReportAnalysis(
  database: TransactionDatabase, uid: string, analysisId: string,
  result: Infer<typeof ReportAssessmentSchema> | Infer<typeof CleanupAssessmentSchema> | null,
  kind: 'REPORT' | 'CLEANUP' = 'REPORT',
) {
  const analysisKind = kind === 'CLEANUP' ? 'CLEANUP' : 'REPORT';
  const assessment = result === null ? null : (analysisKind === 'CLEANUP' ? CleanupAssessmentSchema : ReportAssessmentSchema).parse(result);
  return database.withTransaction(async (client) => {
    const lease = await client.query(
      `SELECT current_analysis_id FROM analysis_leases
       WHERE owner_user_id = $1 AND kind = '${analysisKind}' AND current_analysis_id = $2::uuid
         AND lease_until > clock_timestamp() FOR UPDATE`, [uid, analysisId],
    );
    if (!lease.rows.length) return false;
    const updated = await client.query<{ id: string }>(
      `UPDATE ai_analyses SET status = $3::analysis_status, result = $4::jsonb,
         expires_at = CASE WHEN $3 = 'READY' THEN clock_timestamp() + interval '30 minutes' ELSE NULL END,
         updated_at = clock_timestamp()
       WHERE id = $1::uuid AND owner_user_id = $2 AND kind = '${analysisKind}' AND status = 'RUNNING'
         AND consumed_at IS NULL AND expires_at > clock_timestamp() AND EXISTS (
           SELECT 1 FROM analysis_leases l WHERE l.owner_user_id = $2 AND l.kind = '${analysisKind}'
             AND l.current_analysis_id = $1::uuid AND l.lease_until > clock_timestamp()
         ) RETURNING id`,
      [analysisId, uid, assessment === null ? 'FAILED' : 'READY', assessment === null ? null : JSON.stringify(assessment)],
    );
    if (assessment !== null && updated.rows[0]) {
      await client.query(
        `UPDATE analysis_leases l SET lease_until = a.expires_at, updated_at = clock_timestamp()
         FROM ai_analyses a WHERE l.owner_user_id = $1 AND l.kind = '${analysisKind}'
           AND l.current_analysis_id = $2::uuid AND a.id = l.current_analysis_id`,
        [uid, analysisId],
      );
    }
    return updated.rows.length === 1;
  });
}

export async function readReportAnalysis(database: TransactionDatabase, uid: string, analysisId: string, requestId: string) {
  return database.withTransaction(async (client) => {
    const result = await client.query<AnalysisAttempt>(
      `SELECT a.id, a.kind, a.status, a.result, a.expires_at, a.consumed_at,
         COALESCE(l.current_analysis_id = a.id, false) AS current_attempt,
         COALESCE(l.lease_until > clock_timestamp(), false) AS lease_active,
         COALESCE(a.expires_at > clock_timestamp(), false) AS unexpired
       FROM ai_analyses a LEFT JOIN analysis_leases l
         ON l.owner_user_id = a.owner_user_id AND l.kind = a.kind AND l.input_hash = a.input_hash
       WHERE a.id = $1::uuid AND a.owner_user_id = $2`, [analysisId, uid],
    );
    const attempt = result.rows[0];
    if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Analysis not found.');
    if (attempt.status === 'READY') {
      if (!attempt.current_attempt || !attempt.lease_active || !attempt.unexpired || attempt.consumed_at !== null) {
        throw new ApiError(410, 'EXPIRED', 'This analysis is no longer usable. Start a new attempt.');
      }
      const assessment = (attempt.kind === 'CLEANUP' ? CleanupAssessmentSchema : ReportAssessmentSchema).safeParse(attempt.result);
      if (!assessment.success) throw new ApiError(502, 'AI_INVALID_OUTPUT', 'The saved AI result could not be validated.');
      return { analysisId: attempt.id, status: 'READY' as const, result: assessment.data,
        expiresAt: new Date(attempt.expires_at!).toISOString() };
    }
    if (attempt.status === 'RUNNING' && attempt.current_attempt && attempt.lease_active && attempt.unexpired) {
      return { analysisId: attempt.id, status: 'RUNNING' as const };
    }
    return { analysisId: attempt.id, status: 'FAILED' as const, error: {
      code: 'AI_UNAVAILABLE' as const, message: 'Analysis did not complete. Retry with a new operation key; your photos are retained.',
      requestId, retryable: true,
    } };
  });
}
