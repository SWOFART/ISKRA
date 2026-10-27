import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { WorkerEnv } from './context';

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function handleError(error: Error, c: Context<WorkerEnv>) {
  const safe = error instanceof ApiError
    ? error
    : new ApiError(500, 'INTERNAL_ERROR', 'The request could not be completed.');
  return c.json({
    error: {
      code: safe.code,
      message: safe.message,
      requestId: c.get('requestId'),
      retryable: safe.retryable,
    },
  }, safe.status);
}
