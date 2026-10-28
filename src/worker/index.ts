import { Hono } from 'hono';
import { boundedBody } from './middleware/body';
import type { WorkerEnv } from './middleware/context';
import { ApiError, handleError } from './middleware/errors';
import { apiSecurity } from './middleware/security';
import { createHealthRoutes } from './routes/health';
import { createDomainRoutes, type DomainRouteDependencies } from './routes/domain';
import { createRequestScopedDatabase, type RequestScopedDatabaseFactory } from './db/runtime';
import type { verifyFirebaseToken } from './middleware/auth';

export function createApp(domainDependencies: DomainRouteDependencies = {}) {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.use('/api/*', boundedBody);
  app.route('/api', createHealthRoutes());
  app.route('/api', createDomainRoutes(domainDependencies));
  app.notFound((c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      throw new ApiError(404, 'NOT_FOUND', 'This API route does not exist.');
    }
    throw new ApiError(503, 'UNAVAILABLE', 'The client application is not integrated yet.', true);
  });
  app.onError(handleError);
  return app;
}

export interface WorkerHandlerDependencies {
  readonly createDatabase?: RequestScopedDatabaseFactory;
  readonly verify?: typeof verifyFirebaseToken;
}

/**
 * Bind each request to its own lazy PostgreSQL client. Hyperdrive owns connection
 * pooling; the request-scoped database closes its client after the response.
 */
export function createWorkerHandler({
  createDatabase = createRequestScopedDatabase,
  verify,
}: WorkerHandlerDependencies = {}) {
  return {
    async fetch(request: Request, env: WorkerEnv['Bindings'], executionContext: ExecutionContext) {
      const binding = env.HYPERDRIVE;
      if (!binding?.connectionString.trim()) {
        return createApp({ verify }).fetch(request, env, executionContext);
      }

      const runtime = createDatabase(binding.connectionString);
      try {
        return await createApp({ database: runtime.database, verify }).fetch(request, env, executionContext);
      } finally {
        await runtime.close();
      }
    },
  };
}

export default createWorkerHandler();
