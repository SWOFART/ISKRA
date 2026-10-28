import { Hono } from 'hono';
import { boundedBody } from './middleware/body';
import type { WorkerEnv } from './middleware/context';
import { ApiError, handleError } from './middleware/errors';
import { apiSecurity } from './middleware/security';
import { createHealthRoutes } from './routes/health';
import { createPhotoRoutes } from './routes/photos';
import { createReportMediaResolver } from './services/media';
import { removeExpiredPhotos } from './db/evidence-store';
import { createDomainRoutes, type DomainRouteDependencies } from './routes/domain';
import { createRequestScopedDatabase, type RequestScopedDatabaseFactory } from './db/runtime';
import type { verifyFirebaseToken } from './middleware/auth';

export function createApp(domainDependencies: DomainRouteDependencies = {}) {
  const app = new Hono<WorkerEnv>();
  app.use('*', apiSecurity);
  app.use('/api/*', boundedBody);
  app.route('/api', createHealthRoutes());
  app.route('/api', createDomainRoutes(domainDependencies));
  app.route('/api', createPhotoRoutes(domainDependencies));
  app.notFound(async (c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      throw new ApiError(404, 'NOT_FOUND', 'This API route does not exist.');
    }
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      throw new ApiError(404, 'NOT_FOUND', 'This route does not exist.');
    }
    if (c.env.ASSETS) {
      const projectId = c.env.FIREBASE_PROJECT_ID ?? '';
      const authFrame = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
        ? `https://${projectId}.firebaseapp.com` : "'none'";
      c.header('Content-Security-Policy', `default-src 'self'; script-src 'self' https://apis.google.com; style-src 'self'; style-src-elem 'self'; img-src 'self' data: blob: https://api.maptiler.com; font-src 'self' data: https://api.maptiler.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://api.maptiler.com; worker-src 'self'; frame-src ${authFrame}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`);
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
    async scheduled(_event: ScheduledController, env: WorkerEnv['Bindings']) {
      if (!env.HYPERDRIVE?.connectionString.trim() || !env.PHOTOS) {
        throw new ApiError(503, 'UNAVAILABLE', 'Photo cleanup is not configured.');
      }
      const runtime = createDatabase(env.HYPERDRIVE.connectionString);
      try { await removeExpiredPhotos(runtime.database, env.PHOTOS); }
      finally { await runtime.close(); }
    },
    async fetch(request: Request, env: WorkerEnv['Bindings'], executionContext: ExecutionContext) {
      const binding = env.HYPERDRIVE;
      if (!binding?.connectionString.trim()) {
        return createApp({ verify }).fetch(request, env, executionContext);
      }

      const runtime = createDatabase(binding.connectionString);
      try {
        const reportMedia = env.PHOTOS && env.MEDIA_SIGNING_SECRET
          ? createReportMediaResolver(new URL(request.url).origin, env.MEDIA_SIGNING_SECRET) : undefined;
        return await createApp({ database: runtime.database, reportMedia, verify }).fetch(request, env, executionContext);
      } finally {
        await runtime.close();
      }
    },
  };
}

export default createWorkerHandler();
