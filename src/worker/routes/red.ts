import { Hono, type Context } from 'hono';
import {
  RedDraftCreateRequestSchema,
  RedDraftUpdateRequestSchema,
  RedSentDeclarationRequestSchema,
} from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import { requireAuth, verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { parseJsonBody } from '../middleware/validation';
import { PostgresRedAssistanceService } from '../services/red-assistance';

export interface RedRouteDependencies {
  readonly database: TransactionDatabase;
  readonly verify?: typeof verifyFirebaseToken;
}

function invalidRequest(): never {
  throw new ApiError(400, 'INVALID_INPUT', 'The Red draft request is invalid.');
}

function requireNoQuery(url: string) {
  if (new URL(url).search !== '') invalidRequest();
}

function identity(c: Context<WorkerEnv>) {
  const actorId = c.get('identity')?.uid;
  if (!actorId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return actorId;
}

export function createRedRoutes({ database, verify = verifyFirebaseToken }: RedRouteDependencies) {
  const service = new PostgresRedAssistanceService(database);
  const auth = requireAuth(verify);

  return new Hono<WorkerEnv>()
    .get('/reports/:id/red-draft', auth, async (c) => {
      requireNoQuery(c.req.url);
      const result = await service.get(identity(c), c.req.param('id'));
      c.header('Cache-Control', 'no-store');
      return c.json({ draft: result.draft }, 200);
    })
    .post('/reports/:id/red-draft', auth, async (c) => {
      requireNoQuery(c.req.url);
      const input = await parseJsonBody(c, RedDraftCreateRequestSchema);
      const result = await service.create(identity(c), c.req.param('id'), input.locale);
      c.header('Cache-Control', 'no-store');
      return c.json({ draft: result.draft }, result.responseStatus as 200 | 201);
    })
    .patch('/reports/:id/red-draft', auth, async (c) => {
      requireNoQuery(c.req.url);
      const input = await parseJsonBody(c, RedDraftUpdateRequestSchema);
      const result = await service.update(identity(c), c.req.param('id'), input.text);
      c.header('Cache-Control', 'no-store');
      return c.json({ draft: result.draft }, 200);
    })
    .post('/reports/:id/red-draft/sent', auth, async (c) => {
      requireNoQuery(c.req.url);
      const input = await parseJsonBody(c, RedSentDeclarationRequestSchema);
      const receipt = await service.declareSent(identity(c), c.req.param('id'), input.sent);
      c.header('Cache-Control', 'no-store');
      return c.json(receipt, 200);
    });
}
