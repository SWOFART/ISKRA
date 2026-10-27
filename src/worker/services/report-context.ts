import {
  PhotoSchema,
  PublicReportDetailSchema,
  ReportDetailSchema,
  ReportListQuerySchema,
  ReportListSchema,
  ReportSummarySchema,
  UuidSchema,
  ViewerReportDetailSchema,
  type Photo,
  type Point,
  type ReportListQuery,
  type ReportSummary,
  type Stage,
} from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import { ApiError } from '../middleware/errors';

/** Minimal private context C needs to bind cleanup analysis to the before evidence. */
export interface ReportContext {
  readonly reportId: ReportSummary['id'];
  readonly route: ReportSummary['route'];
  readonly status: ReportSummary['status'];
  readonly beforePhotoIds: readonly string[];
  /** Stable SHA-256 identity of the immutable before-photo set, not report.version. */
  readonly beforeEvidenceHash: string;
  readonly reportLocation: Point;
  readonly description: ReportSummary['description'];
}

/** C reads this narrow view before provider work; implementations keep SQL details in B. */
export interface ReportContextReader {
  getForCleanupAnalysis(reportId: ReportContext['reportId']): Promise<ReportContext | null>;
}

interface ContextRow extends Record<string, unknown> {
  report_id: string;
  route: string;
  status: string;
  description: string;
  lat: number;
  lng: number;
  photo_id: string | null;
  ordinal: number | null;
  sha256: string | null;
}

/** B-owned PostgreSQL projection for C's cleanup analysis; only verified GREEN reports are eligible. */
export class PostgresReportContextReader implements ReportContextReader {
  constructor(private readonly database: TransactionDatabase) {}

  async getForCleanupAnalysis(reportId: ReportContext['reportId']): Promise<ReportContext | null> {
    return this.database.withTransaction(async (client) => {
      const result = await client.query<ContextRow>(
        `SELECT r.id AS report_id, r.route, r.status, r.description, r.lat, r.lng,
           p.id AS photo_id, p.ordinal, p.sha256
         FROM reports r
         LEFT JOIN report_photos p
           ON p.report_id = r.id AND p.purpose = 'REPORT' AND p.state = 'ATTACHED'
         WHERE r.id = $1::uuid AND r.route = 'GREEN' AND r.status = 'VERIFIED'
         ORDER BY p.ordinal ASC`,
        [reportId],
      );
      const first = result.rows[0];
      if (!first) return null;
      const photos = result.rows.filter((row) => row.photo_id !== null);
      if (photos.length < 1 || photos.length > 5 || photos.some((photo, index) =>
        photo.ordinal !== index || !photo.sha256)) return null;

      const evidence = JSON.stringify(photos.map((photo) => [photo.ordinal, photo.photo_id, photo.sha256]));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(evidence));
      const beforeEvidenceHash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return {
        reportId: first.report_id,
        route: 'GREEN',
        status: 'VERIFIED',
        beforePhotoIds: photos.map((photo) => photo.photo_id!),
        beforeEvidenceHash,
        reportLocation: { lat: first.lat, lng: first.lng },
        description: first.description,
      };
    });
  }
}

export interface AttachedPhotoReference {
  readonly id: string;
  /** One-based ordinal as returned by the public contract. */
  readonly ordinal: number;
  readonly purpose: 'REPORT' | 'CLEANUP';
}

/** C supplies expiring HTTPS capabilities for these database-confirmed attached photos. */
export interface ReportMediaResolver {
  resolveAttachedPhotos(photos: readonly AttachedPhotoReference[]): Promise<readonly Photo[]>;
}

interface SummaryRow extends Record<string, unknown> {
  id: string;
  route: string;
  status: string;
  lat: number;
  lng: number;
  cover_photo_id: string;
  description: string;
  existence_yes_count: number;
  resolution_yes_count: number;
  existence_verified_at: Date | string | null;
  last_existence_confirmed_at: Date | string | null;
  version: number;
  updated_at: Date | string;
  is_demo: boolean;
}

interface ListRow extends SummaryRow {
  published_at_cursor: string;
}

interface PhotoReferenceRow { id: string; ordinal: number; }

interface DetailRow extends SummaryRow {
  author_user_id: string;
  author_nickname: string;
  author_avatar: string;
  cleaner_user_id: string | null;
  cleaner_nickname: string | null;
  cleaner_avatar: string | null;
  before_photos: PhotoReferenceRow[];
  after_photos: PhotoReferenceRow[];
  viewer_existence_voted: boolean;
  viewer_resolution_voted: boolean;
}

interface Cursor {
  readonly publishedAt: string;
  readonly id: string;
}

function asTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('Database returned an invalid timestamp.');
  return parsed.toISOString();
}

function toSummary(row: SummaryRow): ReportSummary {
  return ReportSummarySchema.parse({
    id: row.id,
    route: row.route,
    status: row.status,
    location: { lat: Number(row.lat), lng: Number(row.lng) },
    coverPhotoId: row.cover_photo_id,
    description: row.description,
    existenceYesCount: Number(row.existence_yes_count),
    resolutionYesCount: Number(row.resolution_yes_count),
    existenceVerifiedAt: asTimestamp(row.existence_verified_at),
    lastExistenceConfirmedAt: asTimestamp(row.last_existence_confirmed_at),
    version: Number(row.version),
    updatedAt: asTimestamp(row.updated_at),
    isDemo: row.is_demo,
  });
}

function parseCursor(value: string | null): Cursor | null {
  if (value === null) return null;
  const delimiter = value.lastIndexOf('~');
  try {
    if (delimiter <= 0) throw new TypeError('Invalid report list cursor.');
    const publishedAt = value.slice(0, delimiter);
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/.exec(publishedAt);
    if (!match) throw new TypeError('Invalid report cursor timestamp.');
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59) {
      throw new TypeError('Invalid report cursor timestamp.');
    }
    return {
      publishedAt,
      id: UuidSchema.parse(value.slice(delimiter + 1)),
    };
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', 'The report cursor is invalid.');
  }
}

function makeCursor(publishedAt: string, id: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(publishedAt)) {
    throw new TypeError('Database returned an invalid publication timestamp.');
  }
  return `${publishedAt}~${id}`;
}

function pendingVerificationPredicate(actorParameter: string | null): string {
  if (!actorParameter) return `r.status IN ('AWAITING_EXISTENCE', 'AWAITING_RESOLUTION')`;
  return `(
    (r.status = 'AWAITING_EXISTENCE'
      AND r.author_user_id <> ${actorParameter}
      AND NOT EXISTS (
        SELECT 1 FROM votes v WHERE v.report_id = r.id AND v.stage = 'EXISTENCE'
          AND v.voter_user_id = ${actorParameter}
      ))
    OR
    (r.status = 'AWAITING_RESOLUTION'
      AND COALESCE(cleanup.cleaner_user_id, '') <> ${actorParameter}
      AND NOT EXISTS (
        SELECT 1 FROM votes v WHERE v.report_id = r.id AND v.stage = 'RESOLUTION'
          AND v.voter_user_id = ${actorParameter}
      ))
  )`;
}

function stagePermission(
  stageIsOpen: boolean,
  actorId: string | undefined,
  isSelf: boolean,
  hasVoted: boolean,
) {
  if (!stageIsOpen) return { canVote: false as const, reason: 'STAGE_CLOSED' as const, hasVoted };
  if (!actorId) return { canVote: false as const, reason: 'UNAUTHENTICATED' as const, hasVoted: false };
  if (isSelf) return { canVote: false as const, reason: 'SELF_VOTE' as const, hasVoted };
  if (hasVoted) return { canVote: false as const, reason: 'ALREADY_VOTED' as const, hasVoted: true };
  return { canVote: true as const, reason: null, hasVoted: false };
}

function stageIsOpen(status: string, stage: Stage): boolean {
  if (status === 'RESOLVED') return false;
  return stage === 'EXISTENCE' || status === 'AWAITING_RESOLUTION';
}

/** PostgreSQL-backed public report projections. Private columns are selected only for permission decisions. */
export class PostgresReportReadService {
  constructor(
    private readonly database: TransactionDatabase,
    private readonly media?: ReportMediaResolver,
  ) {}

  async list(query: ReportListQuery, viewerId?: string): Promise<ReturnType<typeof ReportListSchema.parse>> {
    const cursor = parseCursor(query.cursor);
    const values: unknown[] = [query.cityId];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const where = ['r.city_id = $1'];
    if (!query.resolved) where.push("r.status <> 'RESOLVED'");
    if (query.routes) where.push(`r.route = ANY(${parameter(query.routes)}::report_route[])`);
    if (query.bbox && !query.needsVerification) {
      const [west, south, east, north] = query.bbox.split(',').map(Number);
      const westParameter = parameter(west);
      const southParameter = parameter(south);
      const eastParameter = parameter(east);
      const northParameter = parameter(north);
      where.push(`r.lng BETWEEN ${westParameter} AND ${eastParameter}
        AND r.lat BETWEEN ${southParameter} AND ${northParameter}`);
    }
    let actorParameter: string | null = null;
    if (query.needsVerification) {
      if (viewerId) actorParameter = parameter(viewerId);
      where.push(pendingVerificationPredicate(actorParameter));
    }
    if (cursor) {
      const timestampParameter = parameter(cursor.publishedAt);
      const idParameter = parameter(cursor.id);
      where.push(`(r.published_at, r.id) < (${timestampParameter}::timestamptz, ${idParameter}::uuid)`);
    }
    const limitParameter = parameter(query.limit + 1);
    const rows = await this.database.withTransaction(async (client) => client.query<ListRow>(
      `SELECT r.id, r.route, r.status, r.lat, r.lng, cover.id AS cover_photo_id, r.description,
         r.existence_yes_count, r.resolution_yes_count, r.existence_verified_at,
         r.last_existence_confirmed_at, r.version, r.updated_at, r.is_demo,
         to_char(r.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           AS published_at_cursor
       FROM reports r
       JOIN LATERAL (
         SELECT p.id FROM report_photos p
         WHERE p.report_id = r.id AND p.purpose = 'REPORT' AND p.state = 'ATTACHED'
         ORDER BY p.ordinal ASC LIMIT 1
       ) cover ON true
       LEFT JOIN cleanup_submissions cleanup ON cleanup.report_id = r.id
       WHERE ${where.join('\n AND ')}
       ORDER BY r.published_at DESC, r.id DESC
       LIMIT ${limitParameter}`,
      values,
    ));
    const hasMore = rows.rows.length > query.limit;
    const pageRows = rows.rows.slice(0, query.limit);
    const items = pageRows.map(toSummary);
    const last = pageRows.at(-1);
    return ReportListSchema.parse({
      items,
      nextCursor: hasMore && last ? makeCursor(last.published_at_cursor, last.id) : null,
    });
  }

  async getDetail(reportId: string, viewerId?: string) {
    const rows = await this.database.withTransaction(async (client) => client.query<DetailRow>(
      `SELECT r.id, r.route, r.status, r.lat, r.lng, r.description, r.existence_yes_count,
         r.resolution_yes_count, r.existence_verified_at, r.last_existence_confirmed_at,
         r.version, r.updated_at, r.is_demo, r.author_user_id,
         author.nickname AS author_nickname, author.avatar_key AS author_avatar,
         cleanup.cleaner_user_id, cleaner.nickname AS cleaner_nickname,
         cleaner.avatar_key AS cleaner_avatar,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'ordinal', p.ordinal + 1)
           ORDER BY p.ordinal) FROM report_photos p
           WHERE p.report_id = r.id AND p.purpose = 'REPORT' AND p.state = 'ATTACHED'), '[]'::jsonb)
           AS before_photos,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'ordinal', p.ordinal + 1)
           ORDER BY p.ordinal) FROM report_photos p
           WHERE p.cleanup_id = cleanup.id AND p.purpose = 'CLEANUP' AND p.state = 'ATTACHED'), '[]'::jsonb)
           AS after_photos,
         ($2::text IS NOT NULL AND EXISTS (SELECT 1 FROM votes v
           WHERE v.report_id = r.id AND v.stage = 'EXISTENCE' AND v.voter_user_id = $2::text))
           AS viewer_existence_voted,
         ($2::text IS NOT NULL AND EXISTS (SELECT 1 FROM votes v
           WHERE v.report_id = r.id AND v.stage = 'RESOLUTION' AND v.voter_user_id = $2::text))
           AS viewer_resolution_voted
       FROM reports r
       JOIN users author ON author.id = r.author_user_id
       LEFT JOIN cleanup_submissions cleanup ON cleanup.report_id = r.id
       LEFT JOIN users cleaner ON cleaner.id = cleanup.cleaner_user_id
       WHERE r.id = $1::uuid`,
      [reportId, viewerId ?? null],
    ));
    const row = rows.rows[0];
    if (!row) return null;
    const beforeRefs = row.before_photos.map((photo) => ({ ...photo, purpose: 'REPORT' as const }));
    const afterRefs = row.after_photos.map((photo) => ({ ...photo, purpose: 'CLEANUP' as const }));
    const references: AttachedPhotoReference[] = [...beforeRefs, ...afterRefs];
    if (!references.length) throw new TypeError('Published report has no attached before photos.');
    if (!this.media) {
      throw new ApiError(503, 'UNAVAILABLE', 'Report photos are not available yet.');
    }

    let capabilities: readonly Photo[];
    try {
      capabilities = await this.media.resolveAttachedPhotos(references);
    } catch {
      throw new ApiError(503, 'UNAVAILABLE', 'Report photos are temporarily unavailable.');
    }
    const byId = new Map<string, Photo>();
    for (const candidate of capabilities) {
      const photo = PhotoSchema.parse(candidate);
      if (byId.has(photo.id) || Date.parse(photo.expiresAt) <= Date.now()) {
        throw new TypeError('Media resolver returned a duplicate or expired capability.');
      }
      byId.set(photo.id, photo);
    }
    if (byId.size !== references.length) throw new TypeError('Media resolver returned an incomplete projection.');
    const resolved = references.map((reference) => {
      const photo = byId.get(reference.id);
      if (!photo || photo.ordinal !== reference.ordinal) {
        throw new TypeError('Media resolver returned an inconsistent attached photo.');
      }
      return photo;
    });
    const beforePhotos = resolved.slice(0, beforeRefs.length);
    const afterPhotos = resolved.slice(beforeRefs.length);
    const currentStage: Stage | null = row.status === 'RESOLVED' ? null
      : row.status === 'AWAITING_RESOLUTION' ? 'RESOLUTION' : 'EXISTENCE';
    const openVoteStages: Stage[] = row.status === 'RESOLVED' ? []
      : row.status === 'AWAITING_RESOLUTION' ? ['EXISTENCE', 'RESOLUTION'] : ['EXISTENCE'];
    const base = {
      ...toSummary({ ...row, cover_photo_id: beforeRefs[0]?.id }),
      beforePhotos,
      afterPhotos,
      author: { id: row.author_user_id, nickname: row.author_nickname, avatar: row.author_avatar },
      cleaner: row.cleaner_user_id === null ? null : {
        id: row.cleaner_user_id,
        nickname: row.cleaner_nickname,
        avatar: row.cleaner_avatar,
      },
      currentStage,
      openVoteStages,
    };
    if (!viewerId) return PublicReportDetailSchema.parse(base);
    return ReportDetailSchema.parse({
      ...base,
      viewer: {
        stages: {
          EXISTENCE: stagePermission(stageIsOpen(row.status, 'EXISTENCE'), viewerId,
            row.author_user_id === viewerId, row.viewer_existence_voted),
          RESOLUTION: stagePermission(stageIsOpen(row.status, 'RESOLUTION'), viewerId,
            row.cleaner_user_id === viewerId, row.viewer_resolution_voted),
        },
        canSubmitCleanup: row.route === 'GREEN' && row.status === 'VERIFIED',
      },
    });
  }
}
