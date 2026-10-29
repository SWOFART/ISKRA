import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ErrorEnvelopeSchema } from '../../../src/shared/contracts';
import type { CheckedOutClient, QueryResult, TransactionDatabase } from '../../../src/worker/db/client';
import type { WorkerEnv } from '../../../src/worker/middleware/context';
import { handleError } from '../../../src/worker/middleware/errors';
import { createDomainRoutes } from '../../../src/worker/routes/domain';
import type { ReportContext, ReportContextReader } from '../../../src/worker/services/report-context';

const requestId = '11111111-1111-4111-8111-111111111111';

function createTestApp() {
  const app = new Hono<WorkerEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', requestId);
    await next();
  });
  app.route('/api', createDomainRoutes());
  app.onError(handleError);
  return app;
}

describe('domain and database facades', () => {
  it.each([
    ['GET', '/api/reports'],
    ['GET', '/api/reports/11111111-1111-4111-8111-000000000001'],
    ['POST', '/api/reports'],
    ['POST', '/api/reports/11111111-1111-4111-8111-000000000001/votes'],
    ['POST', '/api/reports/11111111-1111-4111-8111-000000000001/cleanups'],
    ['GET', '/api/me/impact'],
    ['GET', '/api/me/notifications'],
    ['PATCH', '/api/me/notifications/11111111-1111-4111-8111-000000000007'],
  ])('%s %s returns a truthful unavailable error', async (method, path) => {
    const response = await createTestApp().request(path, { method });
    expect(response.status).toBe(503);
    const error = ErrorEnvelopeSchema.parse(await response.json());
    expect(error.error.code).toBe('UNAVAILABLE');
    expect(error.error.retryable).toBe(true);
    expect(error.error.requestId).toBe(requestId);
  });

  it('mounts beside another router without claiming its paths', async () => {
    const app = createTestApp();
    app.get('/api/health', (c) => c.json({ ok: true }));
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('lets an integration consumer use the checked-out-client transaction type', async () => {
    const id = '11111111-1111-4111-8111-000000000001';
    let queryCount = 0;
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      _text: string,
      _parameters?: readonly unknown[],
    ): Promise<QueryResult<Row>> => {
      queryCount += 1;
      return { rows: [{ id } as unknown as Row], rowCount: 1 };
    };
    const client: CheckedOutClient = { query };
    const database: TransactionDatabase = { withTransaction: (work) => work(client) };
    const result = await database.withTransaction(async (tx) => {
      const selected = await tx.query<{ id: string }>('SELECT id FROM reports WHERE id = $1', [id]);
      return selected.rows[0]?.id;
    });
    expect(result).toBe(id);
    expect(queryCount).toBe(1);
  });

  it('exposes only the report context required by cleanup analysis', async () => {
    const reportId = '11111111-1111-4111-8111-000000000001';
    const context: ReportContext = {
      reportId,
      route: 'GREEN',
      status: 'VERIFIED',
      beforePhotoIds: ['11111111-1111-4111-8111-000000000002'],
      beforeEvidenceHash: 'a'.repeat(64),
      reportLocation: { lat: 49.14, lng: 9.22 },
      description: 'Controlled contract example.',
    };
    const reader: ReportContextReader = { getForCleanupAnalysis: async () => context };
    expect(await reader.getForCleanupAnalysis(reportId)).toEqual(context);
  });
});
