import { Hono } from 'hono';
import { boundedBody } from './middleware/body';
import type { WorkerEnv } from './middleware/context';
import { ApiError, handleError } from './middleware/errors';
import { apiSecurity } from './middleware/security';
import { createHealthRoutes } from './routes/health';

export function createApp() {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.use('/api/*', boundedBody);
  app.route('/api', createHealthRoutes());
  app.notFound((c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      throw new ApiError(404, 'NOT_FOUND', 'This API route does not exist.');
    }
    throw new ApiError(503, 'UNAVAILABLE', 'The client application is not integrated yet.', true);
  });
  app.onError(handleError);
  return app;
}

export default createApp();
