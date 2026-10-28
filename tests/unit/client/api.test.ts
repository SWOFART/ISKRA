import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BootstrapReceiptSchema,
  EmptyBodySchema,
  PublicationReceiptSchema,
  PublishRequestSchema,
  ReportListSchema,
} from '../../../src/shared/contracts';
import {
  ApiClientError,
  createClientApi,
  DEVELOPMENT_FIXTURE_LABEL,
  type FirebaseTokenProvider,
} from '../../../src/client/api';
import { createOperationKeyScope } from '../../../src/client/operationKey';

const requestId = '11111111-1111-4111-8111-111111111111';

function errorResponse(status: number, code: string, retryable: boolean): Response {
  return new Response(JSON.stringify({
    error: { code, message: 'A safe service message.', requestId, retryable },
  }), { status, headers: { 'Content-Type': 'application/json' } });
}

function successResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('client API transport', () => {
  it('validates public report-list responses and does not add an auth header for guests', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      successResponse({ items: [], nextCursor: null }));
    const api = createClientApi({ mode: 'live', fetcher });

    const result = await api.request({ path: '/reports?cityId=heilbronn', responseSchema: ReportListSchema });

    expect(result.data.items).toEqual([]);
    expect(result.provenance.mode).toBe('live');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });

  it('sends Firebase ID tokens on protected requests', async () => {
    const tokenProvider: FirebaseTokenProvider = { getIdToken: vi.fn(async () => 'firebase-id-token') };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => successResponse({
      user: { id: 'fixture-user', nickname: 'Sample Resident', avatar: 'leaf' },
      balance: 0,
      balanceVersion: 0,
    }));
    const api = createClientApi({ mode: 'live', tokenProvider, fetcher });

    await api.request({ path: '/me/bootstrap', method: 'POST', body: {},
      bodySchema: EmptyBodySchema, responseSchema: BootstrapReceiptSchema });

    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization'))
      .toBe('Bearer firebase-id-token');
    expect(tokenProvider.getIdToken).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('stops protected requests before fetch when no Firebase token is available', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => successResponse({}));
    const api = createClientApi({ mode: 'live', fetcher, tokenProvider: { getIdToken: async () => null } });

    await expect(api.request({ path: '/me/bootstrap', method: 'POST', body: {},
      bodySchema: EmptyBodySchema, responseSchema: BootstrapReceiptSchema }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refreshes an expired token once and retries with the same operation key', async () => {
    const tokenProvider: FirebaseTokenProvider = {
      getIdToken: vi.fn(async (forceRefresh) => forceRefresh ? 'fresh-token' : 'expired-token'),
    };
    const fetcher = vi.fn(async (_input, init) => {
      const authorization = new Headers(init?.headers).get('Authorization');
      return authorization === 'Bearer fresh-token'
        ? successResponse({ user: { id: 'resident', nickname: 'Resident', avatar: 'leaf' }, balance: 5, balanceVersion: 1 })
        : errorResponse(401, 'UNAUTHENTICATED', false);
    });
    const api = createClientApi({ mode: 'live', tokenProvider, fetcher });
    const operation = createOperationKeyScope(() => '22222222-2222-4222-8222-222222222222');

    await api.request({ path: '/me/bootstrap', method: 'POST', body: {},
      bodySchema: EmptyBodySchema, operation, responseSchema: BootstrapReceiptSchema });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tokenProvider.getIdToken).toHaveBeenNthCalledWith(1, false);
    expect(tokenProvider.getIdToken).toHaveBeenNthCalledWith(2, true);
    expect(fetcher.mock.calls.map((call) => new Headers(call[1]?.headers).get('Idempotency-Key')))
      .toEqual([operation.key, operation.key]);
  });

  it('does not refresh repeatedly when the refreshed token is also rejected', async () => {
    const tokenProvider: FirebaseTokenProvider = {
      getIdToken: vi.fn(async (forceRefresh) => forceRefresh ? 'still-invalid' : 'expired-token'),
    };
    const fetcher = vi.fn(async () => errorResponse(401, 'UNAUTHENTICATED', false));
    const api = createClientApi({ mode: 'live', tokenProvider, fetcher });

    await expect(api.request({ path: '/me/bootstrap', method: 'POST', body: {},
      bodySchema: EmptyBodySchema, responseSchema: BootstrapReceiptSchema }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tokenProvider.getIdToken).toHaveBeenCalledTimes(2);
  });

  it('exposes contract retryability and Retry-After without inventing retries', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'RATE_LIMITED', message: 'Please wait.', requestId, retryable: true },
    }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '3' } }));
    const api = createClientApi({ mode: 'live', fetcher });

    await expect(api.request({ path: '/reports', responseSchema: ReportListSchema }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 3000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid or policy-inconsistent error envelopes without exposing raw payloads', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'DATABASE_UNAVAILABLE', message: 'secret sql statement', requestId, retryable: false },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    const api = createClientApi({ mode: 'live', fetcher });

    await expect(api.request({ path: '/reports', responseSchema: ReportListSchema }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
  });

  it('keeps operation keys in memory for one action and rotates only after completion', () => {
    const createId = vi.fn()
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333')
      .mockReturnValueOnce('44444444-4444-4444-8444-444444444444');
    const operation = createOperationKeyScope(createId);

    expect(operation.key).toBe('33333333-3333-4333-8333-333333333333');
    expect(operation.key).toBe('33333333-3333-4333-8333-333333333333');
    operation.complete();
    expect(operation.key).toBe('44444444-4444-4444-8444-444444444444');
    expect(createId).toHaveBeenCalledTimes(2);
  });

  it('requires an in-memory key when a mutation opts into idempotency', async () => {
    const fetcher = vi.fn(async () => successResponse({}));
    const api = createClientApi({ mode: 'live', fetcher });

    await expect(api.request({ path: '/reports', method: 'POST', requiresOperationKey: true,
      responseSchema: ReportListSchema })).rejects.toThrow('in-memory operation key scope');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires an operation key for shared-contract mutation endpoints', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => successResponse({}));
    const api = createClientApi({ mode: 'live', fetcher });

    await expect(api.request({ path: '/reports', method: 'POST', body: {
      analysisId: requestId,
      description: 'A report description.',
    }, bodySchema: PublishRequestSchema, responseSchema: PublicationReceiptSchema }))
      .rejects.toThrow('in-memory operation key scope');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects cross-origin and path-traversal API paths before fetch', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => successResponse({}));
    const api = createClientApi({ mode: 'live', fetcher });

    await expect(api.request({ path: '//outside.test/reports', responseSchema: ReportListSchema }))
      .rejects.toThrow('absolute paths on the configured API origin');
    await expect(api.request({ path: '/../outside', responseSchema: ReportListSchema }))
      .rejects.toThrow('absolute paths on the configured API origin');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('applies authentication and idempotency rules to encoded route paths', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => successResponse({}));
    const api = createClientApi({ mode: 'live', fetcher });

    await expect(api.request({ path: `/reports%2F${requestId}%2Fvotes`, method: 'POST',
      responseSchema: ReportListSchema })).rejects.toThrow('in-memory operation key scope');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses shared P0 fixture schemas and labels fixture responses for display', async () => {
    const api = createClientApi({ mode: 'fixture' });

    const result = await api.request({ path: '/reports', responseSchema: ReportListSchema });

    expect(result.data.items[0]?.isDemo).toBe(true);
    expect(result.provenance).toEqual({ mode: 'fixture', label: DEVELOPMENT_FIXTURE_LABEL });
    expect(result.provenance.label).toContain('NOT LIVE DATA');
  });

  it('never falls back from live API failures to fixture data', async () => {
    const fixtureResolver = vi.fn(() => ({ status: 200, body: { items: [], nextCursor: null } }));
    const fetcher = vi.fn(async () => { throw new Error('private network details'); });
    const api = createClientApi({ mode: 'live', fetcher, fixtureResolver });

    await expect(api.request({ path: '/reports', responseSchema: ReportListSchema }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fixtureResolver).not.toHaveBeenCalled();
  });

  it('fails closed when production is configured for fixtures', () => {
    vi.stubEnv('PROD', true);

    expect(() => createClientApi({ mode: 'fixture' })).toThrow('disabled in production builds');
  });
});
