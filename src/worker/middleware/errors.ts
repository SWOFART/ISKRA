import type { Context } from 'hono';
import { API_ERROR_POLICY, type ApiErrorHttpStatus, type ErrorCode } from '../../shared/contracts';
import type { WorkerEnv } from './context';

export class ApiError extends Error {
  constructor(
    readonly status: ApiErrorHttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean = API_ERROR_POLICY[code].retryable,
  ) {
    super(message);
    const policy = API_ERROR_POLICY[code];
    if (status !== policy.httpStatus || retryable !== policy.retryable || !message || message.length > 500) {
      throw new TypeError('API error must follow the shared v1 policy.');
    }
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
