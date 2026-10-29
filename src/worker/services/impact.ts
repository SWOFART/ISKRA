import { ImpactSchema, ReportSummarySchema, UuidSchema } from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import type { CheckedOutClient } from '../db/client';
import { ApiError } from '../middleware/errors';

const PAGE_SIZE = 100;

interface ImpactCursor {
  readonly lastUpdatedAt: string;
  readonly reportId: string;
}

interface ImpactRow extends Record<string, unknown> {
  reporter_created: number | string;
  reporter_in_progress: number | string;
  reporter_resolved: number | string;
  reporter_earned_rp: number | string;
  reporter_pending_rp: number | string;
  cleaner_submitted: number | string;
  cleaner_pending: number | string;
  cleaner_verified: number | string;
  cleaner_earned_rp: number | string;
  cleaner_pending_rp: number | string;
  verification_accepted_votes: number | string;
  verification_confirmed_reports: number | string;
  verification_earned_rp: number | string;
  total_earned_rp: number | string;
  balance_rp: number | string;
  balance_version: number | string;
  report_id: string | null;
  report_route: string | null;
  report_status: string | null;
  report_lat: number | string | null;
  report_lng: number | string | null;
  cover_photo_id: string | null;
  report_description: string | null;
  report_existence_yes_count: number | string | null;
  report_resolution_yes_count: number | string | null;
  report_existence_verified_at: Date | string | null;
  report_last_existence_confirmed_at: Date | string | null;
  report_version: number | string | null;
  report_updated_at: Date | string | null;
  report_is_demo: boolean | null;
  roles: string[] | null;
  last_updated_at: Date | string | null;
  last_updated_at_cursor: string | null;
}

function parseCursor(value: string | null): ImpactCursor | null {
  if (value === null) return null;
  const delimiter = value.lastIndexOf('~');
  if (delimiter <= 0) throw invalidCursor();
  const lastUpdatedAt = value.slice(0, delimiter);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(lastUpdatedAt);
  if (!match) throw invalidCursor();
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, micros] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59 || !/^\d{6}$/.test(micros)) {
    throw invalidCursor();
  }
  const reportId = UuidSchema.safeParse(value.slice(delimiter + 1));
  if (!reportId.success) throw invalidCursor();
  return { lastUpdatedAt, reportId: reportId.data };
}

function invalidCursor(): ApiError {
  return new ApiError(400, 'INVALID_INPUT', 'The Impact cursor is invalid.');
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('Database returned an invalid Impact timestamp.');
  return parsed.toISOString();
}

function number(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError('Database returned an invalid Impact count.');
  }
  return parsed;
}

async function loadImpact(client: CheckedOutClient, actorId: string, cursor: ImpactCursor | null) {
  const result = await client.query<ImpactRow>(
    `WITH account AS (
       SELECT COALESCE(u.rp_balance, 0)::int AS balance_rp,
         COALESCE(u.version, 0)::int AS balance_version
       FROM (VALUES (1)) AS seed(value)
       LEFT JOIN users u ON u.id = $1::text
     ), reporter_activity AS (
       SELECT r.id, r.status, r.reporter_total_rp,
         COALESCE(SUM(l.delta), 0)::int AS earned_rp
       FROM reports r
       LEFT JOIN reward_ledger l ON l.report_id = r.id AND l.user_id = $1::text
         AND l.kind IN ('REPORT_INITIAL', 'REPORT_FINAL') AND l.is_demo = false
       WHERE r.author_user_id = $1::text AND r.is_demo = false
       GROUP BY r.id
     ), reporter_stats AS (
       SELECT COUNT(*)::int AS created,
         COUNT(*) FILTER (WHERE status <> 'RESOLVED')::int AS in_progress,
         COUNT(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved,
         COALESCE(SUM(earned_rp), 0)::int AS earned_rp,
         COALESCE(SUM(CASE WHEN status <> 'RESOLVED'
           THEN GREATEST(0, reporter_total_rp - earned_rp) ELSE 0 END), 0)::int AS pending_rp
       FROM reporter_activity
     ), cleaner_activity AS (
       SELECT c.id, c.status, r.cleaner_rp,
         COALESCE(SUM(l.delta), 0)::int AS earned_rp
       FROM cleanup_submissions c
       JOIN reports r ON r.id = c.report_id
       LEFT JOIN reward_ledger l ON l.report_id = r.id AND l.user_id = $1::text
         AND l.kind = 'CLEANUP' AND l.is_demo = false
       WHERE c.cleaner_user_id = $1::text AND c.is_demo = false AND r.is_demo = false
       GROUP BY c.id, r.cleaner_rp
     ), cleaner_stats AS (
       SELECT COUNT(*)::int AS submitted,
         COUNT(*) FILTER (WHERE status = 'AWAITING_VERIFICATION')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'VERIFIED')::int AS verified,
         COALESCE(SUM(earned_rp), 0)::int AS earned_rp,
         COALESCE(SUM(CASE WHEN status = 'AWAITING_VERIFICATION'
           THEN GREATEST(0, cleaner_rp - earned_rp) ELSE 0 END), 0)::int AS pending_rp
       FROM cleaner_activity
     ), verification_stats AS (
       SELECT COUNT(*)::int AS accepted_votes,
         COUNT(DISTINCT v.report_id) FILTER (WHERE v.choice = 'YES')::int AS confirmed_reports,
         COALESCE((SELECT SUM(l.delta)::int
           FROM reward_ledger l
           JOIN votes credited_vote ON credited_vote.id = l.vote_id
           JOIN reports credited_report ON credited_report.id = credited_vote.report_id
           WHERE l.user_id = $1::text AND l.kind = 'VOTE' AND l.is_demo = false
             AND credited_vote.voter_user_id = $1::text AND credited_vote.is_demo = false
             AND credited_report.is_demo = false), 0)::int AS earned_rp
       FROM votes v
       JOIN reports r ON r.id = v.report_id
       WHERE v.voter_user_id = $1::text AND v.is_demo = false AND r.is_demo = false
     ), activity_roles AS (
       SELECT r.id AS report_id, 'REPORTER'::text AS role, r.updated_at AS relevant_at
       FROM reports r
       WHERE r.author_user_id = $1::text AND r.is_demo = false
       UNION ALL
       SELECT r.id, 'CLEANER'::text, GREATEST(r.updated_at, c.updated_at)
       FROM cleanup_submissions c JOIN reports r ON r.id = c.report_id
       WHERE c.cleaner_user_id = $1::text AND c.is_demo = false AND r.is_demo = false
       UNION ALL
       SELECT r.id, 'VERIFIER'::text, GREATEST(r.updated_at, v.created_at)
       FROM votes v JOIN reports r ON r.id = v.report_id
       WHERE v.voter_user_id = $1::text AND v.is_demo = false AND r.is_demo = false
     ), activity_items AS (
       SELECT r.id, r.route, r.status, r.lat, r.lng, r.description,
         r.existence_yes_count, r.resolution_yes_count, r.existence_verified_at,
         r.last_existence_confirmed_at, r.version, r.updated_at, r.is_demo,
         cover.id AS cover_photo_id,
         ARRAY_AGG(DISTINCT activity.role ORDER BY activity.role) AS roles,
         MAX(activity.relevant_at) AS last_updated_at
       FROM activity_roles activity
       JOIN reports r ON r.id = activity.report_id
       JOIN LATERAL (
         SELECT p.id FROM report_photos p
         WHERE p.report_id = r.id AND p.purpose = 'REPORT' AND p.state = 'ATTACHED'
         ORDER BY p.ordinal ASC LIMIT 1
       ) cover ON true
       GROUP BY r.id, cover.id
     )
     SELECT reporter.created AS reporter_created,
       reporter.in_progress AS reporter_in_progress,
       reporter.resolved AS reporter_resolved,
       reporter.earned_rp AS reporter_earned_rp,
       reporter.pending_rp AS reporter_pending_rp,
       cleaner.submitted AS cleaner_submitted,
       cleaner.pending AS cleaner_pending,
       cleaner.verified AS cleaner_verified,
       cleaner.earned_rp AS cleaner_earned_rp,
       cleaner.pending_rp AS cleaner_pending_rp,
       verification.accepted_votes AS verification_accepted_votes,
       verification.confirmed_reports AS verification_confirmed_reports,
       verification.earned_rp AS verification_earned_rp,
       (reporter.earned_rp + cleaner.earned_rp + verification.earned_rp)::int AS total_earned_rp,
       account.balance_rp, account.balance_version,
       item.id AS report_id, item.route AS report_route, item.status AS report_status,
       item.lat AS report_lat, item.lng AS report_lng, item.cover_photo_id,
       item.description AS report_description,
       item.existence_yes_count AS report_existence_yes_count,
       item.resolution_yes_count AS report_resolution_yes_count,
       item.existence_verified_at AS report_existence_verified_at,
       item.last_existence_confirmed_at AS report_last_existence_confirmed_at,
       item.version AS report_version, item.updated_at AS report_updated_at,
       item.is_demo AS report_is_demo, item.roles,
       item.last_updated_at,
       to_char(item.last_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
         AS last_updated_at_cursor
     FROM account CROSS JOIN reporter_stats reporter CROSS JOIN cleaner_stats cleaner
       CROSS JOIN verification_stats verification
     LEFT JOIN LATERAL (
       SELECT activity_items.* FROM activity_items
       WHERE $2::timestamptz IS NULL
         OR (activity_items.last_updated_at, activity_items.id)
           < ($2::timestamptz, $3::uuid)
       ORDER BY activity_items.last_updated_at DESC, activity_items.id DESC
       LIMIT $4::int
     ) item ON true
     ORDER BY item.last_updated_at DESC NULLS LAST, item.id DESC NULLS LAST`,
    [actorId, cursor?.lastUpdatedAt ?? null, cursor?.reportId ?? null, PAGE_SIZE + 1],
  );

  const first = result.rows[0];
  if (!first) throw new TypeError('Impact query returned no aggregate row.');
  const rowsWithItems = result.rows.filter((row) => row.report_id !== null);
  const pageRows = rowsWithItems.slice(0, PAGE_SIZE);
  const hasMore = rowsWithItems.length > PAGE_SIZE;
  const items = pageRows.map((row) => ({
    report: ReportSummarySchema.parse({
      id: row.report_id,
      route: row.report_route,
      status: row.report_status,
      location: { lat: Number(row.report_lat), lng: Number(row.report_lng) },
      coverPhotoId: row.cover_photo_id,
      description: row.report_description,
      existenceYesCount: Number(row.report_existence_yes_count),
      resolutionYesCount: Number(row.report_resolution_yes_count),
      existenceVerifiedAt: timestamp(row.report_existence_verified_at),
      lastExistenceConfirmedAt: timestamp(row.report_last_existence_confirmed_at),
      version: number(row.report_version!),
      updatedAt: timestamp(row.report_updated_at),
      isDemo: row.report_is_demo,
    }),
    roles: row.roles,
    lastUpdatedAt: timestamp(row.last_updated_at),
  }));
  const last = pageRows.at(-1);

  return ImpactSchema.parse({
    reporter: {
      created: number(first.reporter_created),
      inProgress: number(first.reporter_in_progress),
      resolved: number(first.reporter_resolved),
      earnedRp: number(first.reporter_earned_rp),
      pendingRp: number(first.reporter_pending_rp),
    },
    cleaner: {
      submitted: number(first.cleaner_submitted),
      pending: number(first.cleaner_pending),
      verified: number(first.cleaner_verified),
      earnedRp: number(first.cleaner_earned_rp),
      pendingRp: number(first.cleaner_pending_rp),
    },
    verification: {
      acceptedVotes: number(first.verification_accepted_votes),
      confirmedReports: number(first.verification_confirmed_reports),
      earnedRp: number(first.verification_earned_rp),
    },
    totals: {
      earnedRp: number(first.total_earned_rp),
      balanceRp: number(first.balance_rp),
    },
    impactScore: null,
    impactScoreState: 'NOT_CONFIGURED',
    balanceVersion: number(first.balance_version),
    items,
    nextCursor: hasMore && last?.last_updated_at_cursor && last.report_id
      ? `${last.last_updated_at_cursor}~${last.report_id}` : null,
  });
}

/** Owner-only activity and reward projection from one canonical PostgreSQL statement. */
export class PostgresImpactService {
  constructor(private readonly database: TransactionDatabase) {}

  get(actorId: string, cursorValue: string | null = null) {
    const cursor = parseCursor(cursorValue);
    return this.database.withTransaction((client) => loadImpact(client, actorId, cursor));
  }
}
