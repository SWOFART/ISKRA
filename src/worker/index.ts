import { Hono } from 'hono';
import { boundedBody } from './middleware/body';
import type { WorkerEnv } from './middleware/context';
import { ApiError, handleError } from './middleware/errors';
import { apiSecurity } from './middleware/security';
import { createHealthRoutes } from './routes/health';
import { createDomainRoutes } from './routes/domain';
import { createUploadRoutes } from './routes/uploads';
import type { TransactionDatabase } from './db/client';
import type { verifyFirebaseToken } from './middleware/auth';

export function createApp(dependencies: { database?: TransactionDatabase; verify?: typeof verifyFirebaseToken } = {}) {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.use('/api/*', boundedBody);
  app.route('/api', createHealthRoutes());
  app.route('/api', createDomainRoutes());
  app.route('/api', createUploadRoutes(dependencies));
  app.notFound(async (c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      throw new ApiError(404, 'NOT_FOUND', 'This API route does not exist.');
    }
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      throw new ApiError(404, 'NOT_FOUND', 'This route does not exist.');
    }
    if (c.env.ASSETS) {
      c.header('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      let response = await c.env.ASSETS.fetch(c.req.raw);
      const path = c.req.path;
      const fileRequest = path === '/assets' || path.startsWith('/assets/')
        || path.slice(path.lastIndexOf('/') + 1).includes('.');
      // shortcut: client routes are extensionless; revise fallback if dotted routes are introduced.
      if (response.status === 404 && !fileRequest) {
        const index = new URL(c.req.url);
        index.pathname = '/';
        response = await c.env.ASSETS.fetch(new Request(index, c.req.raw));
      }
      return c.newResponse(response.body, response);
    }
    throw new ApiError(503, 'UNAVAILABLE', 'Client assets are unavailable.', true);
  });
  app.onError(handleError);
  return app;
}

export default createApp();
