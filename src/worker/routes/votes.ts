import { Hono } from 'hono';
import { UuidSchema, VoteRequestSchema } from '../../shared/contracts';
import { requireAuth, verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { parseJsonBody } from '../middleware/validation';
import type { TransactionDatabase } from '../db/client';
import type { ReportMediaResolver } from '../services/report-context';
import { PostgresReportVotingService } from '../services/voting';

export interface VoteRouteDependencies {
  readonly database: TransactionDatabase;
  readonly media?: ReportMediaResolver;
  readonly verify?: typeof verifyFirebaseToken;
  readonly now?: () => number;
}

function invalidVote(): ApiError {
  return new ApiError(400, 'INVALID_INPUT', 'The vote request is invalid.');
}

export function createVoteRoutes({ database, media, verify = verifyFirebaseToken, now }: VoteRouteDependencies) {
  const voting = new PostgresReportVotingService(database, media, now);
  return new Hono<WorkerEnv>().post('/reports/:id/votes', requireAuth(verify), async (c) => {
    const actorId = c.get('identity')?.uid;
    if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const reportId = UuidSchema.safeParse(c.req.param('id'));
    const key = UuidSchema.safeParse(c.req.header('Idempotency-Key'));
    if (!reportId.success || !key.success) throw invalidVote();
    const input = await parseJsonBody(c, VoteRequestSchema);
    const result = await voting.vote(actorId, key.data, reportId.data, input);
    c.header('Cache-Control', 'no-store');
    return c.json(result.receipt, result.responseStatus);
  });
}
