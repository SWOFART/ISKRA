import { Hono } from 'hono';
import { API_ERROR_POLICY } from '../../shared/contracts';
import type { TransactionDatabase } from '../db/client';
import { verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { createMeRoutes } from './me';
import { createReportRoutes } from './reports';
import { createVoteRoutes } from './votes';
import type { ReportMediaResolver } from '../services/report-context';

const unavailable = () => {
  const policy = API_ERROR_POLICY.UNAVAILABLE;
  throw new ApiError(policy.httpStatus, 'UNAVAILABLE', 'This domain endpoint is not integrated yet.', policy.retryable);
};

export interface DomainRouteDependencies {
  readonly database?: TransactionDatabase;
  readonly reportMedia?: ReportMediaResolver;
  readonly verify?: typeof verifyFirebaseToken;
  readonly now?: () => number;
}

/** B-owned domain route mount. C mounts this facade under /api and injects runtime dependencies. */
export function createDomainRoutes({ database, reportMedia, verify, now }: DomainRouteDependencies = {}) {
  const routes = new Hono<WorkerEnv>();
  if (database) {
    routes.route('/', createMeRoutes({ database, verify }));
    routes.route('/', createReportRoutes({ database, media: reportMedia, verify }));
    routes.route('/', createVoteRoutes({ database, media: reportMedia, verify, now }));
  }
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
