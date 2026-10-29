import { Hono } from 'hono';
import { DemoRewardRedemptionRequestSchema, UuidSchema } from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import { requireAuth, verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { parseJsonBody } from '../middleware/validation';
import { PostgresDemoRewardService } from '../services/rewards';

export interface RewardRouteDependencies {
  readonly database: TransactionDatabase;
  readonly verify?: typeof verifyFirebaseToken;
}

function invalidRewardRequest(): never {
  throw new ApiError(400, 'INVALID_INPUT', 'The reward request is invalid.');
}

function voucherCursor(url: string): string | null {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some((key) => key !== 'cursor') || params.getAll('cursor').length > 1) {
    invalidRewardRequest();
  }
  const cursor = params.get('cursor');
  if (cursor !== null && cursor.length > 128) invalidRewardRequest();
  return cursor;
}

export function createRewardRoutes({ database, verify = verifyFirebaseToken }: RewardRouteDependencies) {
  const rewards = new PostgresDemoRewardService(database);
  return new Hono<WorkerEnv>()
    .get('/rewards/catalog', async (c) => {
      if (new URL(c.req.url).search) invalidRewardRequest();
      const catalog = await rewards.getCatalog();
      c.header('Cache-Control', 'no-store');
      return c.json(catalog, 200);
    })
    .post('/rewards/:id/redeem', requireAuth(verify), async (c) => {
      const actorId = c.get('identity')?.uid;
      const catalogId = UuidSchema.safeParse(c.req.param('id'));
      const key = UuidSchema.safeParse(c.req.header('Idempotency-Key'));
      if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      if (!catalogId.success || !key.success) invalidRewardRequest();
      const input = await parseJsonBody(c, DemoRewardRedemptionRequestSchema);
      const result = await rewards.redeem(actorId, key.data, catalogId.data, input);
      c.header('Cache-Control', 'no-store');
      return c.json(result.value, result.responseStatus as 200 | 201);
    })
    .get('/me/vouchers', requireAuth(verify), async (c) => {
      const actorId = c.get('identity')?.uid;
      if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      const result = await rewards.listVouchers(actorId, voucherCursor(c.req.url));
      c.header('Cache-Control', 'no-store');
      return c.json(result, 200);
    });
}
