import { describe, expect, it } from 'vitest';
import { API_ERROR_POLICY, EmptyBodySchema, ErrorEnvelopeSchema, type ErrorCode } from '../../../src/shared/contracts';
import { createApp } from '../../../src/worker';
import { ApiError } from '../../../src/worker/middleware/errors';
import { parseJsonBody } from '../../../src/worker/middleware/validation';

describe('mounted v1 API boundary', () => {
  it.each(Object.entries(API_ERROR_POLICY))('uses the shared HTTP/retry policy for %s', async (code, policy) => {
    const app = createApp();
    app.get('/api/test-error', () => { throw new ApiError(policy.httpStatus, code as ErrorCode, 'Safe failure.'); });
    const response = await app.request('/api/test-error');
    expect(response.status).toBe(policy.httpStatus);
    expect(ErrorEnvelopeSchema.parse(await response.json()).error).toMatchObject({ code, retryable: policy.retryable });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('redacts programming mistakes in error status/retry mapping', async () => {
    const app = createApp();
    app.get('/api/bad-mapping', () => { throw new ApiError(413, 'INVALID_INPUT', 'Sensitive diagnostic.'); });
    const response = await app.request('/api/bad-mapping');
    expect(response.status).toBe(500);
    const body = ErrorEnvelopeSchema.parse(await response.json());
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).not.toContain('diagnostic');
    expect(() => new ApiError(503, 'UNAVAILABLE', 'safe', false)).toThrow();
  });

  it.each([
    ['GET', '/api/reports'], ['GET', '/api/me/impact'],
  ])('mounts B facade %s %s with honest JSON unavailability', async (method, path) => {
    const response = await createApp().request(path, { method });
    expect(response.status).toBe(503);
    expect(ErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('UNAVAILABLE');
  });

  it.each(['{}', '{"userId":"forged-private-user"}', '{"status":"RESOLVED"}', '{"rp":999}', '{invalid', '[]'])
  ('validates strict JSON input %s without reflecting input', async (body) => {
    const app = createApp();
    app.post('/api/test-input', async (c) => c.json(await parseJsonBody(c, EmptyBodySchema)));
    const response = await app.request('/api/test-input', {
      method: 'POST', body, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    expect(response.status).toBe(body === '{}' ? 200 : 400);
    if (body !== '{}') {
      const error = ErrorEnvelopeSchema.parse(await response.json()).error;
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).not.toContain('forged-private-user');
      expect(error.message).not.toContain('RESOLVED');
    }
  });

  it('rejects non-JSON request types and keeps internal schema failures as 500', async () => {
    const app = createApp();
    app.post('/api/test-input', async (c) => c.json(await parseJsonBody(c, EmptyBodySchema)));
    app.get('/api/test-output', () => { EmptyBodySchema.parse({ privateValue: 'sensitive' }); return new Response(); });
    expect((await app.request('/api/test-input', { method: 'POST', body: '{}' })).status).toBe(400);
    const response = await app.request('/api/test-output');
    expect(response.status).toBe(500);
    expect(ErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('INTERNAL_ERROR');
  });

  it('maps oversized JPEG bodies to PHOTO_TOO_LARGE rather than a contradictory INVALID_INPUT status', async () => {
    const response = await createApp().request('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(1_048_577),
    });
    expect(response.status).toBe(413);
    expect(ErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('PHOTO_TOO_LARGE');
  });
});
