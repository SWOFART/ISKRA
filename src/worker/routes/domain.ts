import { Hono } from 'hono';
import { API_ERROR_POLICY } from '../../shared/contracts';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';

const unavailable = () => {
  const policy = API_ERROR_POLICY.UNAVAILABLE;
  throw new ApiError(policy.httpStatus, 'UNAVAILABLE', 'This domain endpoint is not integrated yet.', policy.retryable);
};

/** B-owned domain route mount. C mounts this facade under /api. */
export function createDomainRoutes() {
  return new Hono<WorkerEnv>()
    .post('/me/bootstrap', unavailable)
    .get('/reports', unavailable)
    .get('/reports/:id', unavailable)
    .post('/reports', unavailable)
    .post('/reports/:id/votes', unavailable)
    .post('/reports/:id/cleanups', unavailable)
    .get('/me/impact', unavailable)
    .get('/me/notifications', unavailable)
    .patch('/me/notifications/:id', unavailable);
}
