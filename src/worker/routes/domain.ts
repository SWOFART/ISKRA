import { Hono } from 'hono';
import { API_ERROR_POLICY } from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import { verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { createMeRoutes } from './me';

const unavailable = () => {
  const policy = API_ERROR_POLICY.UNAVAILABLE;
  throw new ApiError(policy.httpStatus, 'UNAVAILABLE', 'This domain endpoint is not integrated yet.', policy.retryable);
};

export interface DomainRouteDependencies {
  readonly database?: TransactionDatabase;
  readonly verify?: typeof verifyFirebaseToken;
}

/** B-owned domain route mount. C mounts this facade under /api and injects runtime dependencies. */
export function createDomainRoutes({ database, verify }: DomainRouteDependencies = {}) {
  const routes = new Hono<WorkerEnv>();
  if (database) routes.route('/', createMeRoutes({ database, verify }));
  else routes.post('/me/bootstrap', unavailable);

  return routes
    .get('/reports', unavailable)
    .get('/reports/:id', unavailable)
    .post('/reports', unavailable)
    .post('/reports/:id/votes', unavailable)
    .post('/reports/:id/cleanups', unavailable)
    .get('/me/impact', unavailable)
    .get('/me/notifications', unavailable)
    .patch('/me/notifications/:id', unavailable);
}
