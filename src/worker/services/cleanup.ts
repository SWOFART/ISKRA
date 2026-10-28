import {
  CleanupAssessmentSchema,
  CleanupReceiptSchema,
  LocationSchema,
  PhotoIdsSchema,
  POLICY,
  UuidSchema,
} from '../../shared/contracts';
import { distanceM } from '../../shared/location';
import {
  executeIdempotently,
  IdempotencyConflictError,
  type CheckedOutClient,
  type TransactionDatabase,
} from '../db/client';
import { ApiError } from '../middleware/errors';
import {
  hashBeforeEvidence,
  PostgresReportReadService,
  type ReportDetailSnapshot,
  type ReportMediaResolver,
} from './report-context';

interface LockedReport extends Record<string, unknown> {
  id: string;
  route: string;
  status: string;
  lat: number;
  lng: number;
  is_demo: boolean;
}

interface AnalysisLookup extends Record<string, unknown> {
  id: string;
  input_hash: string;
}

interface AnalysisRow extends AnalysisLookup {
  status: string;
  photo_ids: unknown;
  context: unknown;
  result: unknown;
  expires_at: Date | string | null;
  consumed_at: Date | string | null;
  is_demo: boolean;
  unexpired: boolean;
}

interface LeaseRow extends Record<string, unknown> {
  current_analysis_id: string;
  active: boolean;
}

interface PhotoRow extends Record<string, unknown> {
  id: string;
  owner_user_id: string;
  purpose: string;
  state: string;
  report_id: string | null;
  cleanup_id: string | null;
  ordinal: number;
  upload_active: boolean;
}

interface BeforePhotoRow extends Record<string, unknown> {
  id: string;
  ordinal: number;
  sha256: string;
}

interface CleanupReceiptState {
  readonly cleanupId: string;
  readonly reportSnapshot: ReportDetailSnapshot;
}

interface CleanupAnalysisContext {
  readonly beforeEvidenceHash: string;
  readonly location: ReturnType<typeof LocationSchema.parse>;
}

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
}

function analysisConsumed(): never {
  throw new ApiError(409, 'ANALYSIS_CONSUMED', 'This analysis can no longer be submitted.');
}

function cleanupAlreadySubmitted(): never {
  throw new ApiError(409, 'CLEANUP_ALREADY_SUBMITTED', 'A valid cleanup has already been submitted for this report.');
}

function invalidStoredAnalysis(): never {
  throw new ApiError(502, 'AI_INVALID_OUTPUT', 'The saved cleanup analysis cannot be submitted.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAnalysisContext(value: unknown, reportId: string): CleanupAnalysisContext {
  if (!isRecord(value)) invalidStoredAnalysis();
  const boundReport = isRecord(value.reportContext) ? value.reportContext : value;
  const recordedReportIds = [value.reportId, boundReport.reportId].filter((candidate) => candidate !== undefined);
  if (recordedReportIds.some((candidate) => typeof candidate !== 'string'
    || candidate.toLowerCase() !== reportId.toLowerCase())) {
    analysisConsumed();
  }
  if ((boundReport.route !== undefined && boundReport.route !== 'GREEN')
    || (boundReport.status !== undefined && boundReport.status !== 'VERIFIED')) analysisConsumed();

  const hashes = [value.beforeEvidenceHash, boundReport.beforeEvidenceHash]
    .filter((candidate) => candidate !== undefined);
  const validHashes = hashes.filter((candidate): candidate is string =>
    typeof candidate === 'string' && /^[0-9a-f]{64}$/i.test(candidate));
  if (validHashes.length !== hashes.length) {
    invalidStoredAnalysis();
  }
  if (validHashes.length === 2 && validHashes[0].toLowerCase() !== validHashes[1].toLowerCase()) analysisConsumed();
  const beforeEvidenceHash = validHashes[0];
  if (!beforeEvidenceHash) invalidStoredAnalysis();
  const location = LocationSchema.safeParse(value.location);
  if (!location.success) invalidStoredAnalysis();
  return { beforeEvidenceHash: beforeEvidenceHash.toLowerCase(), location: location.data };
}

async function requestHash(reportId: string, analysisId: string): Promise<string> {
  const value = JSON.stringify({ reportId: reportId.toLowerCase(), analysisId: analysisId.toLowerCase() });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pgConstraint(error: unknown, code: string, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { code?: unknown; constraint?: unknown };
  return value.code === code && value.constraint === constraint;
}

async function currentCleanup(
  client: CheckedOutClient,
  cleanupId: string,
  reportId: string,
  actorId: string,
) {
  const result = await client.query<{ id: string; report_id: string }>(
    `SELECT id, report_id FROM cleanup_submissions
     WHERE id = $1::uuid AND report_id = $2::uuid AND cleaner_user_id = $3::text`,
    [cleanupId, reportId, actorId],
  );
  if (!result.rows[0]) notFound();
  return result.rows[0];
}

/** Accepts the sole valid cleanup candidate and its photos under the report lock. */
export class PostgresCleanupSubmissionService {
  private readonly reports: PostgresReportReadService;

  constructor(
    private readonly database: TransactionDatabase,
    private readonly media?: ReportMediaResolver,
    private readonly now: () => number = Date.now,
  ) {
    this.reports = new PostgresReportReadService(database, media);
  }

  async submit(actorId: string, idempotencyKey: string, reportId: string, input: { readonly analysisId: string }) {
    if (!this.media) {
      throw new ApiError(503, 'UNAVAILABLE', 'Report photos are not available yet.', true);
    }
    const key = UuidSchema.parse(idempotencyKey).toLowerCase();
    const targetId = UuidSchema.parse(reportId).toLowerCase();
    const analysisId = UuidSchema.parse(input.analysisId).toLowerCase();
    let execution;
    try {
      execution = await executeIdempotently<CleanupReceiptState>(
        this.database,
        {
          actorId,
          operation: 'CLEANUP_SUBMISSION',
          key,
          requestHash: await requestHash(targetId, analysisId),
        },
        async (client) => {
          const reportResult = await client.query<LockedReport>(
            `SELECT id, route, status, lat, lng, is_demo
             FROM reports WHERE id = $1::uuid FOR UPDATE`,
            [targetId],
          );
          const report = reportResult.rows[0];
          if (!report) notFound();

          const priorCleanup = await client.query<{ id: string }>(
            'SELECT id FROM cleanup_submissions WHERE report_id = $1::uuid', [targetId],
          );
          if (priorCleanup.rows[0]) cleanupAlreadySubmitted();
          if (report.route !== 'GREEN') {
            throw new ApiError(403, 'NOT_ELIGIBLE', 'Cleanup can only be submitted for a verified GREEN report.');
          }
          if (report.status !== 'VERIFIED') {
            throw new ApiError(409, 'STAGE_CLOSED', 'This report is not accepting a cleanup submission.');
          }
          if (report.is_demo) {
            throw new ApiError(403, 'FORBIDDEN', 'Demo reports cannot receive live cleanup submissions.');
          }

          const firstAnalysis = await client.query<AnalysisLookup>(
            `SELECT id, input_hash FROM ai_analyses
             WHERE id = $1::uuid AND owner_user_id = $2::text AND kind = 'CLEANUP'
               AND report_id = $3::uuid`,
            [analysisId, actorId, targetId],
          );
          const lookup = firstAnalysis.rows[0];
          if (!lookup) notFound();

          // Match the evidence producer's lease-then-attempt lock order. A superseded
          // or expired analysis cannot regain submit permission through a late reply.
          const leaseResult = await client.query<LeaseRow>(
            `SELECT current_analysis_id, lease_until > clock_timestamp() AS active
             FROM analysis_leases
             WHERE owner_user_id = $1::text AND kind = 'CLEANUP' AND input_hash = $2::varchar
             FOR UPDATE`,
            [actorId, lookup.input_hash],
          );
          const lease = leaseResult.rows[0];
          if (!lease || lease.current_analysis_id.toLowerCase() !== analysisId) analysisConsumed();
          if (!lease.active) throw new ApiError(410, 'EXPIRED', 'The cleanup analysis has expired.', true);

          const lockedAnalysis = await client.query<AnalysisRow>(
            `SELECT id, input_hash, status, photo_ids, context, result, expires_at, consumed_at,
               is_demo, expires_at > clock_timestamp() AS unexpired
             FROM ai_analyses
             WHERE id = $1::uuid AND owner_user_id = $2::text AND kind = 'CLEANUP'
               AND report_id = $3::uuid
             FOR UPDATE`,
            [analysisId, actorId, targetId],
          );
          const analysis = lockedAnalysis.rows[0];
          if (!analysis) notFound();
          if (analysis.consumed_at !== null) analysisConsumed();
          if (analysis.status !== 'READY') {
            throw new ApiError(503, 'AI_UNAVAILABLE', 'The cleanup analysis is not ready to submit.', true);
          }
          if (!analysis.unexpired) throw new ApiError(410, 'EXPIRED', 'The cleanup analysis has expired.', true);
          if (analysis.is_demo) {
            throw new ApiError(403, 'FORBIDDEN', 'Demo analyses cannot be submitted as live cleanups.');
          }

          const assessment = CleanupAssessmentSchema.safeParse(analysis.result);
          if (!assessment.success) invalidStoredAnalysis();
          if (assessment.data.decision !== 'ACCEPT') {
            throw new ApiError(422, 'AI_REJECTED', 'Capture clear evidence after safely completing the cleanup.');
          }
          const context = readAnalysisContext(analysis.context, targetId);
          if (Date.parse(context.location.observedAt) > this.now()) {
            throw new ApiError(422, 'LOCATION_STALE', 'The cleanup location fix is not valid yet.', true);
          }
          if (distanceM(context.location, { lat: Number(report.lat), lng: Number(report.lng) }) > POLICY.cleanupRadiusM) {
            throw new ApiError(403, 'TOO_FAR', 'The cleanup location must be within 150 metres of the report.', true);
          }

          const beforePhotosResult = await client.query<BeforePhotoRow>(
            `SELECT id, ordinal, sha256 FROM report_photos
             WHERE report_id = $1::uuid AND purpose = 'REPORT' AND state = 'ATTACHED'
             ORDER BY ordinal FOR UPDATE`,
            [targetId],
          );
          const beforePhotos = beforePhotosResult.rows;
          if (beforePhotos.length < 1 || beforePhotos.length > 5
            || beforePhotos.some((photo, index) => photo.ordinal !== index)) analysisConsumed();
          const currentBeforeHash = await hashBeforeEvidence(beforePhotos);
          if (currentBeforeHash !== context.beforeEvidenceHash) analysisConsumed();

          const photoIds = PhotoIdsSchema.safeParse(analysis.photo_ids);
          if (!photoIds.success) analysisConsumed();
          const uploadedResult = await client.query<PhotoRow>(
            `SELECT id, owner_user_id, purpose, state, report_id, cleanup_id, ordinal,
               upload_expires_at > clock_timestamp() AS upload_active
             FROM report_photos WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
            [photoIds.data],
          );
          if (uploadedResult.rows.length !== photoIds.data.length) analysisConsumed();
          const photosById = new Map(uploadedResult.rows.map((photo) => [photo.id.toLowerCase(), photo]));
          const orderedPhotos = photoIds.data.map((id) => photosById.get(id.toLowerCase()));
          if (orderedPhotos.some((photo, index) => !photo
            || photo.owner_user_id !== actorId
            || photo.purpose !== 'CLEANUP'
            || photo.state !== 'UPLOADED'
            || photo.report_id !== null
            || photo.cleanup_id !== null
            || photo.ordinal !== index)) analysisConsumed();
          if (orderedPhotos.some((photo) => !photo!.upload_active)) {
            throw new ApiError(410, 'EXPIRED', 'One or more cleanup photos have expired.', true);
          }

          const inserted = await client.query<{ id: string }>(
            `INSERT INTO cleanup_submissions (
               report_id, cleaner_user_id, analysis_id, lat, lng, accuracy_m, captured_location_at
             ) VALUES ($1::uuid, $2::text, $3::uuid, $4::double precision, $5::double precision,
               $6::double precision, $7::timestamptz)
             RETURNING id`,
            [targetId, actorId, analysisId, context.location.lat, context.location.lng,
              context.location.accuracyM, context.location.observedAt],
          );
          const cleanupId = inserted.rows[0]?.id;
          if (!cleanupId) throw new Error('Cleanup submission did not return its ID.');

          const attached = await client.query<{ id: string }>(
            `UPDATE report_photos
             SET state = 'ATTACHED', cleanup_id = $2::uuid, updated_at = clock_timestamp()
             WHERE id = ANY($1::uuid[]) AND owner_user_id = $3::text AND purpose = 'CLEANUP'
               AND state = 'UPLOADED' AND report_id IS NULL AND cleanup_id IS NULL
               AND upload_expires_at > clock_timestamp()
             RETURNING id`,
            [photoIds.data, cleanupId, actorId],
          );
          if (attached.rows.length !== photoIds.data.length) analysisConsumed();

          const consumed = await client.query<{ id: string }>(
            `UPDATE ai_analyses SET consumed_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1::uuid AND owner_user_id = $2::text AND kind = 'CLEANUP'
               AND report_id = $3::uuid AND consumed_at IS NULL AND status = 'READY'
               AND expires_at > clock_timestamp()
             RETURNING id`,
            [analysisId, actorId, targetId],
          );
          if (consumed.rows.length !== 1) analysisConsumed();

          const changed = await client.query<{ id: string }>(
            `UPDATE reports SET status = 'AWAITING_RESOLUTION', version = version + 1,
               updated_at = clock_timestamp()
             WHERE id = $1::uuid AND route = 'GREEN' AND status = 'VERIFIED' AND is_demo = false
             RETURNING id`,
            [targetId],
          );
          if (changed.rows.length !== 1) {
            throw new ApiError(409, 'STAGE_CLOSED', 'This report is no longer accepting a cleanup submission.');
          }

          const reportSnapshot = await this.reports.getDetailSnapshot(client, targetId, actorId);
          if (!reportSnapshot) throw new Error('Report disappeared before cleanup commit.');
          return {
            value: { cleanupId, reportSnapshot },
            receipt: { resourceId: cleanupId, responseStatus: 201 },
          };
        },
        async (client, receipt) => {
          const cleanup = await currentCleanup(client, receipt.resourceId, targetId, actorId);
          const reportSnapshot = await this.reports.getDetailSnapshot(client, cleanup.report_id, actorId);
          if (!reportSnapshot) notFound();
          return { cleanupId: cleanup.id, reportSnapshot };
        },
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used with different cleanup data.');
      }
      if (pgConstraint(error, '23505', 'cleanup_submissions_report_id_key')) cleanupAlreadySubmitted();
      throw error;
    }

    const report = await this.reports.projectDetailSnapshot(execution.value.reportSnapshot, actorId);
    if (execution.responseStatus !== 201) throw new Error('Cleanup idempotency receipt has an unexpected response status.');
    return {
      responseStatus: 201 as const,
      receipt: CleanupReceiptSchema.parse({
        cleanupId: execution.value.cleanupId,
        status: 'AWAITING_VERIFICATION',
        provisionalRp: POLICY.cleanerRp,
        report,
      }),
    };
  }
}
