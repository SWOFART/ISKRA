import { Hono } from 'hono';
import { CleanupRequestSchema, UuidSchema } from '../../shared/contracts';
import { ContractError } from '../../shared/schema';
import type { TransactionDatabase } from '../db/client';
import { requireAuth, verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { parseJsonBody } from '../middleware/validation';
import { PostgresCleanupSubmissionService } from '../services/cleanup';
import type { ReportMediaResolver } from '../services/report-context';

export interface CleanupRouteDependencies {
  readonly database: TransactionDatabase;
  readonly media?: ReportMediaResolver;
  readonly verify?: typeof verifyFirebaseToken;
  readonly now?: () => number;
}

const invalidSubmission = () => new ApiError(400, 'INVALID_INPUT', 'The cleanup request is invalid.');

export function createCleanupRoutes({ database, media, verify = verifyFirebaseToken, now }: CleanupRouteDependencies) {
  const submission = new PostgresCleanupSubmissionService(database, media, now);
  return new Hono<WorkerEnv>().post('/reports/:id/cleanups', requireAuth(verify), async (c) => {
    const actorId = c.get('identity')?.uid;
    if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const reportId = UuidSchema.safeParse(c.req.param('id'));
    const idempotencyKey = UuidSchema.safeParse(c.req.header('Idempotency-Key'));
    if (!reportId.success || !idempotencyKey.success) throw invalidSubmission();

    let input;
    try {
      input = await parseJsonBody(c, CleanupRequestSchema);
    } catch (error) {
      if (error instanceof ContractError) throw invalidSubmission();
      throw error;
    }
    const result = await submission.submit(actorId, idempotencyKey.data, reportId.data, input);
    c.header('Cache-Control', 'no-store');
    return c.json(result.receipt, result.responseStatus);
  });
}
