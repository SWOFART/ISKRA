import { Hono } from 'hono';
import { BootstrapReceiptSchema, BootstrapRequestSchema } from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { requireAuth, verifyFirebaseToken } from '../middleware/auth';
import { parseJsonBody } from '../middleware/validation';

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
  return new Hono<WorkerEnv>().post('/me/bootstrap', requireAuth(verify), async (c) => {
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
