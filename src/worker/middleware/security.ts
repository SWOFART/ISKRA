import { createMiddleware } from 'hono/factory';
import type { WorkerEnv } from './context';
import { ApiError } from './errors';

export const apiSecurity = createMiddleware<WorkerEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if ((origin && origin !== new URL(c.req.url).origin)
      || c.req.header('Sec-Fetch-Site') === 'cross-site') {
      throw new ApiError(403, 'FORBIDDEN', 'This request origin is not allowed.');
    }
  }
  await next();
});
