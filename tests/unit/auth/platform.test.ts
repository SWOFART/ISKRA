import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/worker/index';
import { optionalAuth, requireAuth } from '../../../src/worker/middleware/auth';

const env = { RELEASE_SHA: 'test-release', FIREBASE_PROJECT_ID: 'iskra-test' };

describe('Worker API boundary', () => {
  it('returns release health without claiming integrated product readiness', async () => {
    const response = await createApp().request('/api/health', {}, env);
    expect(await response.json()).toEqual({ ok: true, release: 'test-release', applicationReady: false });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('returns JSON 404s for unknown API routes and an honest missing-client response', async () => {
    const app = createApp();
    for (const path of ['/api/unknown', '/api', '/api/health/nope']) {
      const response = await app.request(path, {}, env);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    const response = await app.request('/impact', {}, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { retryable: true } });
  });

  it('uses a server request ID and redacts unknown errors without logging internals', async () => {
    const log = vi.spyOn(console, 'error');
    const app = createApp();
    app.get('/api/fail', () => { throw new Error('SQL password=private-key'); });
    const response = await app.request('/api/fail', { headers: { 'X-Request-ID': 'attacker' } }, env);
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).not.toContain('private-key');
    expect(body).not.toContain('attacker');
    expect(JSON.parse(body).error.requestId).toBe(response.headers.get('X-Request-ID'));
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each<Record<string, string>>([
    { Origin: 'https://attacker.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
  ])('rejects unexpected browser mutation origins %j', async (headers) => {
    const response = await createApp().request('https://iskra.test/api/health', { method: 'POST', headers }, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('allows same-origin requests to reach their route', async () => {
    const app = createApp();
    app.post('/api/action', (c) => c.json({ received: true }));
    const response = await app.request('https://iskra.test/api/action', {
      method: 'POST', headers: { Origin: 'https://iskra.test' },
    }, env);
    expect(response.status).toBe(200);
  });

  it.each([{}, { 'Content-Length': '1' }, { 'Content-Length': '1048577' }])('rejects oversized bodies with headers %j', async (headers) => {
    const app = createApp();
    app.post('/api/upload', (c) => c.json({ reached: true }));
    const response = await app.request('/api/upload', {
      method: 'POST', body: new Uint8Array(1_048_577), headers: headers as Record<string, string>,
    }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('preserves an accepted request body for the route', async () => {
    const app = createApp();
    app.post('/api/action', async (c) => c.json(await c.req.json()));
    const response = await app.request('/api/action', {
      method: 'POST', body: JSON.stringify({ description: 'bounded input' }),
    }, env);
    expect(await response.json()).toEqual({ description: 'bounded input' });
  });
});

describe('auth middleware integration boundary', () => {
  function withAuth(verify = vi.fn(async () => ({ uid: 'verified-resident' }))) {
    const app = createApp();
    app.post('/api/private', requireAuth(verify), (c) => c.json(c.get('identity')));
    app.get('/api/viewer', optionalAuth(verify), (c) => c.json({ identity: c.get('identity') ?? null }));
    return { app, verify };
  }

  it('takes actor identity only from verified bearer content', async () => {
    const { app, verify } = withAuth();
    const response = await app.request('/api/private', {
      method: 'POST', headers: { Authorization: 'Bearer supplied-token' },
      body: JSON.stringify({ userId: 'forged-resident' }),
    }, env);
    expect(verify).toHaveBeenCalledWith('supplied-token', 'iskra-test');
    expect(await response.json()).toEqual({ uid: 'verified-resident' });
  });

  it.each(['', 'Basic abc', 'Bearer a b', 'Bearer'])('rejects missing/malformed credentials %s', async (authorization) => {
    const { app, verify } = withAuth();
    const response = await app.request('/api/private', {
      method: 'POST', headers: { Authorization: authorization },
    }, env);
    expect(response.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it('allows guests but rejects bad supplied credentials on optional-auth routes', async () => {
    const { app } = withAuth(vi.fn(async () => { throw new Error('signature internals'); }));
    expect(await (await app.request('/api/viewer', {}, env)).json()).toEqual({ identity: null });
    const response = await app.request('/api/viewer', { headers: { Authorization: 'Bearer invalid' } }, env);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('signature internals');
  });

  it('fails closed when Firebase project configuration is missing', async () => {
    const { app, verify } = withAuth();
    const response = await app.request('/api/private', {
      method: 'POST', headers: { Authorization: 'Bearer token' },
    }, {});
    expect(response.status).toBe(503);
    expect(verify).not.toHaveBeenCalled();
  });
});
