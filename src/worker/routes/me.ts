import { Hono } from 'hono';
import {
  BootstrapReceiptSchema, BootstrapRequestSchema, LocaleSchema,
  NotificationListSchema, NotificationReadReceiptSchema, NotificationReadRequestSchema,
  UuidSchema,
} from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { requireAuth, verifyFirebaseToken } from '../middleware/auth';
import { parseJsonBody } from '../middleware/validation';
import { PostgresImpactService } from '../services/impact';

const NOTIFICATION_PAGE_SIZE = 100;
const notificationMessages = {
  en: {
    EXISTENCE_VERIFIED: 'Residents confirmed your report.',
    REPORT_RESOLVED: 'Your city is cleaner thanks to you!',
  },
  de: {
    EXISTENCE_VERIFIED: 'Die Bewohner haben deinen Bericht bestätigt.',
    REPORT_RESOLVED: 'Dank dir ist deine Stadt sauberer!',
  },
} as const;

type NotificationLocale = keyof typeof notificationMessages;
type NotificationKind = keyof typeof notificationMessages.en;

interface NotificationRow extends Record<string, unknown> {
  id: string;
  kind: NotificationKind;
  report_id: string;
  read_at: Date | string | null;
  created_at_cursor: string;
}

interface NotificationCursor {
  readonly createdAt: string;
  readonly id: string;
}

function invalidNotificationQuery(): ApiError {
  return new ApiError(400, 'INVALID_INPUT', 'The notification query is invalid.');
}

function parseNotificationCursor(value: string | null): NotificationCursor | null {
  if (value === null) return null;
  const delimiter = value.lastIndexOf('~');
  if (delimiter <= 0) throw invalidNotificationQuery();
  const createdAt = value.slice(0, delimiter);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(createdAt);
  if (!match) throw invalidNotificationQuery();
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
    throw invalidNotificationQuery();
  }
  const id = UuidSchema.safeParse(value.slice(delimiter + 1));
  if (!id.success) throw invalidNotificationQuery();
  return { createdAt, id: id.data };
}

function notificationTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('Database returned an invalid notification timestamp.');
  return parsed.toISOString();
}

function parseNotificationQuery(url: string): { locale: NotificationLocale; cursor: NotificationCursor | null } {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some((key) => key !== 'locale' && key !== 'cursor')
    || params.getAll('locale').length > 1 || params.getAll('cursor').length > 1) {
    throw invalidNotificationQuery();
  }
  const localeValue = params.get('locale');
  const localeResult = localeValue === null ? null : LocaleSchema.safeParse(localeValue);
  if (localeResult && !localeResult.success) throw invalidNotificationQuery();
  return {
    locale: localeResult?.success ? localeResult.data : 'en',
    cursor: parseNotificationCursor(params.get('cursor')),
  };
}

interface UserRow extends Record<string, unknown> {
  id: string;
  nickname: string;
  avatar_key: string;
  rp_balance: number;
  version: number;
}

export interface MeRouteDependencies {
  readonly database: TransactionDatabase;
  readonly verify?: typeof verifyFirebaseToken;
}

/** B-owned authenticated account routes; the database and verifier are provided by runtime integration. */
export function createMeRoutes({ database, verify = verifyFirebaseToken }: MeRouteDependencies) {
  const impact = new PostgresImpactService(database);
  return new Hono<WorkerEnv>()
    .get('/me/impact', requireAuth(verify), async (c) => {
      const actorId = c.get('identity')?.uid;
      if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const params = new URL(c.req.url).searchParams;
      if ([...params.keys()].some((key) => key !== 'cursor') || params.getAll('cursor').length > 1) {
        throw new ApiError(400, 'INVALID_INPUT', 'The Impact query is invalid.');
      }
      const result = await impact.get(actorId, params.get('cursor'));
      c.header('Cache-Control', 'no-store');
      return c.json(result, 200);
    })
    .get('/me/notifications', requireAuth(verify), async (c) => {
      const actorId = c.get('identity')?.uid;
      if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const { locale, cursor } = parseNotificationQuery(c.req.url);
      const result = await database.withTransaction((client) => client.query<NotificationRow>(
        `SELECT id, kind, report_id, read_at,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
         FROM notifications
         WHERE user_id = $1::text
           AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC
         LIMIT $4::int`,
        [actorId, cursor?.createdAt ?? null, cursor?.id ?? null, NOTIFICATION_PAGE_SIZE + 1],
      ));
      const pageRows = result.rows.slice(0, NOTIFICATION_PAGE_SIZE);
      const last = pageRows.at(-1);
      const response = NotificationListSchema.parse({
        items: pageRows.map((row) => ({
          id: row.id,
          kind: row.kind,
          message: notificationMessages[locale][row.kind],
          reportId: row.report_id,
          readAt: notificationTimestamp(row.read_at),
        })),
        nextCursor: result.rows.length > NOTIFICATION_PAGE_SIZE && last
          ? `${last.created_at_cursor}~${last.id}` : null,
      });
      c.header('Cache-Control', 'no-store');
      return c.json(response, 200);
    })
    .patch('/me/notifications/:id', requireAuth(verify), async (c) => {
      const actorId = c.get('identity')?.uid;
      if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const id = UuidSchema.safeParse(c.req.param('id'));
      if (!id.success) throw new ApiError(400, 'INVALID_INPUT', 'The notification ID is invalid.');
      await parseJsonBody(c, NotificationReadRequestSchema);
      const updated = await database.withTransaction((client) => client.query<{
        id: string;
        read_at: Date | string;
      }>(
        `UPDATE notifications SET read_at = COALESCE(read_at, clock_timestamp())
         WHERE id = $1::uuid AND user_id = $2::text
         RETURNING id, read_at`,
        [id.data, actorId],
      ));
      const row = updated.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Notification not found.');
      const response = NotificationReadReceiptSchema.parse({
        id: row.id,
        readAt: notificationTimestamp(row.read_at),
      });
      c.header('Cache-Control', 'no-store');
      return c.json(response, 200);
    })
    .post('/me/bootstrap', requireAuth(verify), async (c) => {
    await parseJsonBody(c, BootstrapRequestSchema);
    const actorId = c.get('identity')?.uid;
    if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

    const receipt = await database.withTransaction(async (client) => {
      const inserted = await client.query<UserRow>(
        `INSERT INTO users (id, nickname)
         VALUES ($1::text, 'Resident-' || substr(gen_random_uuid()::text, 1, 8))
         ON CONFLICT (id) DO NOTHING
         RETURNING id, nickname, avatar_key, rp_balance, version`,
        [actorId],
      );
      const row = inserted.rows[0] ?? (await client.query<UserRow>(
        `SELECT id, nickname, avatar_key, rp_balance, version
         FROM users WHERE id = $1::text`,
        [actorId],
      )).rows[0];
      if (!row) throw new Error('Account bootstrap could not read the resident account.');

      return BootstrapReceiptSchema.parse({
        user: { id: row.id, nickname: row.nickname, avatar: row.avatar_key },
        balance: row.rp_balance,
        balanceVersion: row.version,
      });
    });

    c.header('Cache-Control', 'no-store');
    return c.json(receipt, 200);
    });
}
