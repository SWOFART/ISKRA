import { Hono } from 'hono';
import { ReportListQuerySchema, UuidSchema } from '../../shared/contracts';
import { ContractError } from '../../shared/schema';
import type { TransactionDatabase } from '../db/client';
import { optionalAuth, verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { PostgresReportReadService, type ReportMediaResolver } from '../services/report-context';

export interface ReportRouteDependencies {
  readonly database: TransactionDatabase;
  /** C's photo service turns attached IDs into short-lived, scoped HTTPS capabilities. */
  readonly media?: ReportMediaResolver;
  readonly verify?: typeof verifyFirebaseToken;
}

const invalidQuery = () => new ApiError(400, 'INVALID_INPUT', 'The report query is invalid.');

function parseBoolean(value: string | null, fallback: boolean): boolean | unknown {
  if (value === null) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function parseListQuery(url: string) {
  const params = new URL(url).searchParams;
  const allowed = new Set(['cityId', 'bbox', 'routes', 'needsVerification', 'resolved', 'limit', 'cursor']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw invalidQuery();
  }
  const limitValue = params.get('limit');
  const limit = limitValue === null ? 50
    : /^[1-9]\d{0,2}$/.test(limitValue) ? Number(limitValue) : limitValue;
  try {
    return ReportListQuerySchema.parse({
      cityId: params.get('cityId') ?? 'heilbronn',
      bbox: params.get('bbox'),
      routes: params.has('routes') ? params.get('routes')!.split(',') : null,
      needsVerification: parseBoolean(params.get('needsVerification'), false),
      resolved: parseBoolean(params.get('resolved'), false),
      limit,
      cursor: params.get('cursor'),
    });
  } catch (error) {
    if (error instanceof ContractError) throw invalidQuery();
    throw error;
  }
}

export function createReportRoutes({ database, media, verify = verifyFirebaseToken }: ReportRouteDependencies) {
  const reader = new PostgresReportReadService(database, media);
  return new Hono<WorkerEnv>()
    .get('/reports', optionalAuth(verify), async (c) => {
      const query = parseListQuery(c.req.url);
      const result = await reader.list(query, c.get('identity')?.uid);
      c.header('Cache-Control', 'no-store');
      return c.json(result, 200);
    })
    .get('/reports/:id', optionalAuth(verify), async (c) => {
      const parsedId = UuidSchema.safeParse(c.req.param('id'));
      if (!parsedId.success) throw invalidQuery();
      const detail = await reader.getDetail(parsedId.data, c.get('identity')?.uid);
      if (!detail) throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
      c.header('Cache-Control', 'no-store');
      return c.json(detail, 200);
    });
}
