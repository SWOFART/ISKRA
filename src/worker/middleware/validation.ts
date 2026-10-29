import type { Context } from 'hono';
import { ContractError, type Schema } from '../../shared/schema';
import type { WorkerEnv } from './context';
import { ApiError } from './errors';

export async function parseJsonBody<T>(c: Context<WorkerEnv>, schema: Schema<T>): Promise<T> {
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(400, 'INVALID_INPUT', 'Send an application/json request body.');
  }
  try {
    return schema.parse(await c.req.json());
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ContractError) {
      throw new ApiError(400, 'INVALID_INPUT', 'The request body does not match the expected format.');
    }
    throw error;
  }
}
