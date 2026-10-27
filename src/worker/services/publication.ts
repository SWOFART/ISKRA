import {
  PhotoIdsSchema,
  POLICY,
  ReportAnalysisContextSchema,
  PublicationReceiptSchema,
  ReportAssessmentSchema,
  UuidSchema,
} from '../../shared/contracts';
import {
  AccountNotFoundError,
  executeIdempotently,
  IdempotencyConflictError,
  lockAccounts,
  type CheckedOutClient,
  type TransactionDatabase,
} from '../db/client';
import { ApiError } from '../middleware/errors';
import {
  PostgresReportReadService,
  type ReportDetailSnapshot,
  type ReportMediaResolver,
} from './report-context';

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
  unexpired: boolean | null;
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

interface BalanceRow extends Record<string, unknown> {
  rp_balance: number;
  version: number;
}

interface PublishedReceiptState {
  readonly reportId: string;
  readonly rpAwarded: 0 | 5;
  readonly balance: number;
  readonly balanceVersion: number;
  readonly reportSnapshot: ReportDetailSnapshot;
}

function invalidStoredAnalysis(): never {
  throw new ApiError(502, 'AI_INVALID_OUTPUT', 'The saved analysis cannot be published.');
}

function analysisConsumed(): never {
  throw new ApiError(409, 'ANALYSIS_CONSUMED', 'This analysis can no longer be published.');
}

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
}

async function requestHash(analysisId: string, description: string): Promise<string> {
  const value = JSON.stringify({ analysisId: analysisId.toLowerCase(), description });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function currentBalance(client: CheckedOutClient, actorId: string): Promise<BalanceRow> {
  const rows = await client.query<BalanceRow>(
    'SELECT rp_balance, version FROM users WHERE id = $1::text', [actorId],
  );
  if (!rows.rows[0]) notFound();
  return rows.rows[0];
}

/** Consumes one owned READY+ACCEPT analysis and credits one report atomically. */
export class PostgresReportPublicationService {
  private readonly reports: PostgresReportReadService;

  constructor(
    private readonly database: TransactionDatabase,
    private readonly media?: ReportMediaResolver,
  ) {
    this.reports = new PostgresReportReadService(database, media);
  }

  async publish(
    actorId: string,
    idempotencyKey: string,
    input: { readonly analysisId: string; readonly description: string },
  ) {
    if (!this.media) {
      throw new ApiError(503, 'UNAVAILABLE', 'Report photos are not available yet.', true);
    }
    const key = UuidSchema.parse(idempotencyKey).toLowerCase();
    const analysisId = UuidSchema.parse(input.analysisId).toLowerCase();
    let execution;
    try {
      execution = await executeIdempotently<PublishedReceiptState>(
        this.database,
        {
          actorId,
          operation: 'REPORT_PUBLICATION',
          key,
          requestHash: await requestHash(analysisId, input.description),
        },
        async (client) => {
          try {
            await lockAccounts(client, [actorId]);
          } catch (error) {
            if (error instanceof AccountNotFoundError) notFound();
            throw error;
          }

          const firstRead = await client.query<AnalysisLookup>(
            `SELECT id, input_hash FROM ai_analyses
             WHERE id = $1::uuid AND owner_user_id = $2::text AND kind = 'REPORT'`,
            [analysisId, actorId],
          );
          const lookup = firstRead.rows[0];
          if (!lookup) notFound();

          // Follow the analysis producer's lease-then-attempt lock order. A superseded
          // or expired attempt cannot regain publishability through a delayed response.
          const leaseResult = await client.query<LeaseRow>(
            `SELECT current_analysis_id, lease_until > clock_timestamp() AS active
             FROM analysis_leases
             WHERE owner_user_id = $1::text AND kind = 'REPORT' AND input_hash = $2::varchar
             FOR UPDATE`,
            [actorId, lookup.input_hash],
          );
          const lease = leaseResult.rows[0];
          if (!lease || lease.current_analysis_id.toLowerCase() !== lookup.id.toLowerCase()) {
            analysisConsumed();
          }
          if (!lease.active) throw new ApiError(410, 'EXPIRED', 'The analysis has expired.', true);

          const analysisResult = await client.query<AnalysisRow>(
            `SELECT id, input_hash, status, photo_ids, context, result, expires_at, consumed_at,
               is_demo, expires_at > clock_timestamp() AS unexpired
             FROM ai_analyses
             WHERE id = $1::uuid AND owner_user_id = $2::text AND kind = 'REPORT'
             FOR UPDATE`,
            [analysisId, actorId],
          );
          const analysis = analysisResult.rows[0];
          if (!analysis) notFound();
          if (analysis.consumed_at !== null) analysisConsumed();
          if (analysis.status !== 'READY') {
            throw new ApiError(503, 'AI_UNAVAILABLE', 'The analysis is not ready to publish.', true);
          }
          if (!analysis.unexpired) throw new ApiError(410, 'EXPIRED', 'The analysis has expired.', true);
          if (analysis.is_demo) {
            throw new ApiError(403, 'FORBIDDEN', 'Demo analyses cannot be published as live reports.');
          }

          const storedContext = ReportAnalysisContextSchema.safeParse(analysis.context);
          const photoIds = PhotoIdsSchema.safeParse(analysis.photo_ids);
          const assessment = ReportAssessmentSchema.safeParse(analysis.result);
          if (!storedContext.success || !photoIds.success || !assessment.success) invalidStoredAnalysis();
          if (assessment.data.decision !== 'ACCEPT') {
            throw new ApiError(422, 'AI_REJECTED', 'Capture clearer evidence before publishing.');
          }

          const photoRows = await client.query<PhotoRow>(
            `SELECT id, owner_user_id, purpose, state, report_id, cleanup_id, ordinal,
               upload_expires_at > clock_timestamp() AS upload_active
             FROM report_photos
             WHERE id = ANY($1::uuid[])
             ORDER BY id
             FOR UPDATE`,
            [photoIds.data],
          );
          if (photoRows.rows.length !== photoIds.data.length) analysisConsumed();
          const photosById = new Map(photoRows.rows.map((photo) => [photo.id.toLowerCase(), photo]));
          const orderedPhotos = photoIds.data.map((id) => photosById.get(id.toLowerCase()));
          if (orderedPhotos.some((photo, index) => !photo
            || photo.owner_user_id !== actorId
            || photo.purpose !== 'REPORT'
            || photo.state !== 'UPLOADED'
            || photo.report_id !== null
            || photo.cleanup_id !== null
            || photo.ordinal !== index)) analysisConsumed();
          if (orderedPhotos.some((photo) => !photo!.upload_active)) {
            throw new ApiError(410, 'EXPIRED', 'One or more report photos have expired.', true);
          }

          const reportInsert = await client.query<{ id: string }>(
            `INSERT INTO reports (
               author_user_id, route, status, description, original_ai_description, comment,
               lat, lng, measured_lat, measured_lng, accuracy_m, captured_location_at,
               city_id, analysis_id, reporter_total_rp, initial_rp, cleaner_rp
             ) VALUES (
               $1::text, $2::report_route, 'AWAITING_EXISTENCE', $3::varchar, $4::varchar,
               $5::varchar, $6::double precision, $7::double precision, $8::double precision,
               $9::double precision, $10::double precision, $11::timestamptz, $12::text,
               $13::uuid, $14::integer, $15::integer, $16::integer
             ) RETURNING id`,
            [actorId, assessment.data.route, input.description, assessment.data.description,
              storedContext.data.comment, storedContext.data.pin.lat, storedContext.data.pin.lng,
              storedContext.data.measuredLocation.lat, storedContext.data.measuredLocation.lng,
              storedContext.data.measuredLocation.accuracyM, storedContext.data.measuredLocation.observedAt,
              storedContext.data.cityId, analysis.id, POLICY.reporterTotalRp,
              POLICY.reporterInitialRp, POLICY.cleanerRp],
          );
          const reportId = reportInsert.rows[0]?.id;
          if (!reportId) throw new Error('Report publication did not return its report ID.');

          const attached = await client.query<{ id: string }>(
            `UPDATE report_photos
             SET state = 'ATTACHED', report_id = $2::uuid, updated_at = clock_timestamp()
             WHERE id = ANY($1::uuid[]) AND owner_user_id = $3::text AND purpose = 'REPORT'
               AND state = 'UPLOADED' AND report_id IS NULL AND cleanup_id IS NULL
               AND upload_expires_at > clock_timestamp()
             RETURNING id`,
            [photoIds.data, reportId, actorId],
          );
          if (attached.rows.length !== photoIds.data.length) analysisConsumed();

          await client.query(
            `INSERT INTO reward_ledger (user_id, kind, delta, source_ref, report_id)
             VALUES ($1::text, 'REPORT_INITIAL', 5, $2::varchar, $3::uuid)`,
            [actorId, `report-initial:${reportId}`, reportId],
          );
          const balanceUpdate = await client.query<BalanceRow>(
            `UPDATE users
             SET rp_balance = rp_balance + 5, version = version + 1, updated_at = clock_timestamp()
             WHERE id = $1::text
             RETURNING rp_balance, version`,
            [actorId],
          );
          const balance = balanceUpdate.rows[0];
          if (!balance) notFound();

          const consumed = await client.query<{ id: string }>(
            `UPDATE ai_analyses SET consumed_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1::uuid AND consumed_at IS NULL AND status = 'READY'
               AND expires_at > clock_timestamp()
             RETURNING id`,
            [analysis.id],
          );
          if (consumed.rows.length !== 1) analysisConsumed();
          const reportSnapshot = await this.reports.getDetailSnapshot(client, reportId, actorId);
          if (!reportSnapshot) throw new Error('Published report disappeared before transaction commit.');

          return {
            value: {
              reportId,
              rpAwarded: 5 as const,
              balance: balance.rp_balance,
              balanceVersion: balance.version,
              reportSnapshot,
            },
            receipt: { resourceId: reportId, responseStatus: 201 },
          };
        },
        async (client, receipt) => {
          await lockAccounts(client, [actorId]);
          const report = await client.query<{ id: string }>(
            `SELECT id FROM reports WHERE id = $1::uuid AND author_user_id = $2::text`,
            [receipt.resourceId, actorId],
          );
          if (!report.rows[0]) notFound();
          const balance = await currentBalance(client, actorId);
          const reportSnapshot = await this.reports.getDetailSnapshot(client, report.rows[0].id, actorId);
          if (!reportSnapshot) notFound();
          return {
            reportId: report.rows[0].id,
            rpAwarded: 0 as const,
            balance: balance.rp_balance,
            balanceVersion: balance.version,
            reportSnapshot,
          };
        },
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used with different publication data.');
      }
      throw error;
    }

    const report = await this.reports.projectDetailSnapshot(execution.value.reportSnapshot, actorId);
    if (execution.responseStatus !== 201) {
      throw new Error('Publication idempotency receipt has an unexpected response status.');
    }
    return {
      responseStatus: 201 as const,
      receipt: PublicationReceiptSchema.parse({
        report,
        rpAwarded: execution.value.rpAwarded,
        balance: execution.value.balance,
        balanceVersion: execution.value.balanceVersion,
      }),
    };
  }
}
