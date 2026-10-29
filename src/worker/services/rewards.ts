import {
  DemoRewardCatalogSchema,
  DemoRewardRedemptionRequestSchema,
  DemoRewardVoucherListSchema,
  DemoRewardVoucherSchema,
  UuidSchema,
  type DemoRewardCatalogItem,
  type DemoRewardVoucher,
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

const PAGE_SIZE = 100;
const IDEMPOTENCY_OPERATION = 'DEMO_REWARD_REDEEM';

interface RewardCatalogRow extends Record<string, unknown> {
  id: string;
  title: string;
  description: string;
  cost_rp: number | string;
  demo_terms: string;
}

interface VoucherRow extends Record<string, unknown> {
  id: string;
  catalog_id: string;
  title: string;
  description: string;
  cost_rp_snapshot: number | string;
  display_code: string;
  status: string;
  created_at: Date | string;
  demo_terms: string;
  created_at_cursor?: string;
}

interface VoucherCursor {
  readonly createdAt: string;
  readonly id: string;
}

interface RedemptionResult {
  readonly voucher: DemoRewardVoucher;
  readonly balance: number;
  readonly rpDebited: number;
}

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'The requested reward was not found.');
}

function invalidRequest(): never {
  throw new ApiError(400, 'INVALID_INPUT', 'The reward request is invalid.');
}

function invalidCursor(): never {
  throw new ApiError(400, 'INVALID_INPUT', 'The voucher cursor is invalid.');
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('Database returned an invalid voucher timestamp.');
  return parsed.toISOString();
}

function integer(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError('Database returned an invalid reward integer.');
  return parsed;
}

function parseCursor(value: string | null): VoucherCursor | null {
  if (value === null) return null;
  const delimiter = value.lastIndexOf('~');
  if (delimiter <= 0) invalidCursor();
  const createdAt = value.slice(0, delimiter);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(createdAt);
  if (!match) invalidCursor();
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
    || hour > 23 || minute > 59 || second > 59) invalidCursor();
  const id = UuidSchema.safeParse(value.slice(delimiter + 1));
  if (!id.success) invalidCursor();
  return { createdAt, id: id.data.toLowerCase() };
}

function catalogItem(row: RewardCatalogRow): DemoRewardCatalogItem {
  return {
    id: row.id.toLowerCase(),
    title: row.title,
    description: row.description,
    costRp: integer(row.cost_rp),
    isDemo: true,
    demoTerms: row.demo_terms,
  };
}

function voucher(row: VoucherRow): DemoRewardVoucher {
  return DemoRewardVoucherSchema.parse({
    id: row.id.toLowerCase(),
    catalogId: row.catalog_id.toLowerCase(),
    title: row.title,
    description: row.description,
    costRpSnapshot: integer(row.cost_rp_snapshot),
    displayCode: row.display_code,
    status: row.status,
    createdAt: timestamp(row.created_at),
    isDemo: true,
    demoTerms: row.demo_terms,
  });
}

async function readVoucher(client: CheckedOutClient, voucherId: string, actorId: string) {
  const result = await client.query<VoucherRow>(
    `SELECT v.id, v.catalog_id, c.title, c.description, v.cost_rp_snapshot,
       v.display_code, v.status, v.created_at, c.demo_terms
     FROM user_vouchers v
     JOIN reward_catalog c ON c.id = v.catalog_id
     WHERE v.id = $1::uuid AND v.user_id = $2::text`,
    [voucherId, actorId],
  );
  const row = result.rows[0];
  return row ? voucher(row) : null;
}

async function readBalance(client: CheckedOutClient, actorId: string): Promise<number> {
  const result = await client.query<{ rp_balance: number | string }>(
    'SELECT rp_balance FROM users WHERE id = $1::text', [actorId],
  );
  if (!result.rows[0]) notFound();
  return integer(result.rows[0].rp_balance);
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class PostgresDemoRewardService {
  constructor(private readonly database: TransactionDatabase) {}

  async getCatalog() {
    return this.database.withTransaction(async (client) => {
      const result = await client.query<RewardCatalogRow>(
        `SELECT id, title, description, cost_rp, demo_terms
         FROM reward_catalog WHERE active = true AND is_demo = true
         ORDER BY cost_rp ASC, id ASC`,
      );
      return DemoRewardCatalogSchema.parse({ items: result.rows.map(catalogItem) });
    });
  }

  async redeem(actorId: string, key: string, catalogId: string, input: unknown) {
    const parsedId = UuidSchema.safeParse(catalogId);
    const parsedKey = UuidSchema.safeParse(key);
    const parsedInput = DemoRewardRedemptionRequestSchema.safeParse(input);
    if (!parsedId.success || !parsedKey.success || !parsedInput.success) invalidRequest();

    const itemId = parsedId.data.toLowerCase();
    const idempotencyKey = parsedKey.data.toLowerCase();
    const confirmedCostRp = parsedInput.data.confirmedCostRp;
    const account = await this.database.withTransaction((client) => client.query<{ id: string }>(
      'SELECT id FROM users WHERE id = $1::text', [actorId],
    ));
    if (!account.rows[0]) notFound();
    try {
      return await executeIdempotently<RedemptionResult>(
        this.database,
        {
          actorId,
          operation: IDEMPOTENCY_OPERATION,
          key: idempotencyKey,
          requestHash: await requestHash({ catalogId: itemId, confirmedCostRp }),
        },
        async (client) => {
          try {
            await lockAccounts(client, [actorId]);
          } catch (error) {
            if (error instanceof AccountNotFoundError) notFound();
            throw error;
          }

          const selected = await client.query<RewardCatalogRow>(
            `SELECT id, title, description, cost_rp, demo_terms
             FROM reward_catalog
             WHERE id = $1::uuid AND active = true AND is_demo = true
             FOR UPDATE`,
            [itemId],
          );
          const item = selected.rows[0];
          if (!item) notFound();
          const costRp = integer(item.cost_rp);
          if (confirmedCostRp !== costRp) {
            throw new ApiError(409, 'PRICE_CHANGED', 'The demo reward price changed. Review the current price and confirm again.');
          }

          const balanceBefore = await readBalance(client, actorId);
          if (balanceBefore < costRp) {
            throw new ApiError(409, 'INSUFFICIENT_RP', 'There is not enough RP for this demo reward.');
          }

          const voucherId = crypto.randomUUID().toLowerCase();
          const displayCode = `DEMO-${voucherId.toUpperCase()}`;
          await client.query(
            `INSERT INTO user_vouchers (
               id, user_id, catalog_id, cost_rp_snapshot, redemption_key, display_code, status, is_demo
             ) VALUES ($1::uuid, $2::text, $3::uuid, $4::integer, $5::uuid, $6::varchar, 'RECEIVED', true)`,
            [voucherId, actorId, itemId, costRp, idempotencyKey, displayCode],
          );
          await client.query(
            `INSERT INTO reward_ledger (user_id, kind, delta, source_ref, voucher_id, is_demo)
             VALUES ($1::text, 'REDEMPTION'::ledger_kind, $2::integer, $3::varchar, $4::uuid, true)`,
            [actorId, -costRp, `voucher:${voucherId}:debit`, voucherId],
          );
          const updated = await client.query<{ rp_balance: number | string }>(
            `UPDATE users SET rp_balance = rp_balance - $2::integer,
               version = version + 1, updated_at = clock_timestamp()
             WHERE id = $1::text AND rp_balance >= $2::integer
             RETURNING rp_balance`,
            [actorId, costRp],
          );
          if (!updated.rows[0]) {
            throw new ApiError(409, 'INSUFFICIENT_RP', 'There is not enough RP for this demo reward.');
          }
          const createdVoucher = await readVoucher(client, voucherId, actorId);
          if (!createdVoucher) throw new Error('The created demo voucher could not be read.');

          return {
            value: {
              voucher: createdVoucher,
              balance: integer(updated.rows[0].rp_balance),
              rpDebited: costRp,
            },
            receipt: { resourceId: voucherId, responseStatus: 201 },
          };
        },
        async (client, receipt) => {
          const existingVoucher = await readVoucher(client, receipt.resourceId.toLowerCase(), actorId);
          if (!existingVoucher) notFound();
          const balance = await readBalance(client, actorId);
          return {
            voucher: existingVoucher,
            balance,
            rpDebited: existingVoucher.costRpSnapshot,
          };
        },
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was used for another request.');
      }
      throw error;
    }
  }

  async listVouchers(actorId: string, rawCursor: string | null) {
    const cursor = parseCursor(rawCursor);
    return this.database.withTransaction(async (client) => {
      const result = await client.query<VoucherRow>(
        `SELECT v.id, v.catalog_id, c.title, c.description, v.cost_rp_snapshot,
           v.display_code, v.status, v.created_at, c.demo_terms,
           to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
         FROM user_vouchers v
         JOIN reward_catalog c ON c.id = v.catalog_id
         WHERE v.user_id = $1::text
           AND ($2::timestamptz IS NULL OR (v.created_at, v.id) < ($2::timestamptz, $3::uuid))
         ORDER BY v.created_at DESC, v.id DESC
         LIMIT $4::int`,
        [actorId, cursor?.createdAt ?? null, cursor?.id ?? null, PAGE_SIZE + 1],
      );
      const rows = [...result.rows];
      const hasMore = rows.length > PAGE_SIZE;
      const pageRows = rows.slice(0, PAGE_SIZE);
      const items = pageRows.map((row) => voucher(row));
      const last = pageRows.at(-1);
      const nextCursor = hasMore && last?.created_at_cursor
        ? `${last.created_at_cursor}~${last.id.toLowerCase()}` : null;
      return DemoRewardVoucherListSchema.parse({ items, nextCursor });
    });
  }
}
