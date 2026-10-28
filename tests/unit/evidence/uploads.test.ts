import { decodeJwt, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POLICY, UploadTicketSchema } from '../../../src/shared/contracts';
import { createApp } from '../../../src/worker/index';
import type { TransactionDatabase } from '../../../src/worker/db/client';
import { authorizeUpload } from '../../../src/worker/routes/uploads';

const secret = 'test-only-upload-key-with-at-least-32-bytes';
const env = { FIREBASE_PROJECT_ID: 'iskra-test', MEDIA_SIGNING_SECRET: secret };
const origin = 'https://iskra.test';
const reportId = '10000000-0000-4000-8000-000000000001';
const request = { purpose: 'REPORT', mimeType: 'image/jpeg', byteSize: 123, ordinal: 1 };

function setup() {
  const query = vi.fn(async () => ({ rows: [{ id: 'resident', route: 'GREEN', status: 'VERIFIED' }], rowCount: 1 }));
  const database: TransactionDatabase = {
    withTransaction: (work) => work({ query: query as never }),
  };
  const verify = vi.fn(async (token: string) => {
    if (token !== 'resident') throw new Error('Bad test identity');
    return { uid: 'resident' };
  });
  return { app: createApp({ database, verify }), database, query, verify };
}

async function issue(app: ReturnType<typeof createApp>, body: unknown = request, bindings = env) {
  return app.request(`${origin}/api/uploads`, {
    method: 'POST', headers: { Authorization: 'Bearer resident', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, bindings);
}

async function ticket(app: ReturnType<typeof createApp>, body: unknown = request) {
  const response = await issue(app, body);
  expect(response.status).toBe(201);
  const result = UploadTicketSchema.parse(await response.json());
  return { ...result, token: new URL(result.uploadUrl).searchParams.get('ticket')! };
}

afterEach(() => vi.useRealTimers());

describe('owner-bound upload tickets', () => {
  it('issues an HTTPS five-minute JPEG capability with server identity and an opaque photo ID', async () => {
    const { app, database, query } = setup();
    const response = await issue(app, { ...request, byteSize: POLICY.maxPhotoBytes, ordinal: 5 });
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const result = UploadTicketSchema.parse(await response.json());
    const url = new URL(result.uploadUrl);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe(`/api/uploads/${result.photoId}/content`);
    const token = url.searchParams.get('ticket')!;
    const claims = decodeJwt(token);
    expect(claims.exp! - claims.iat!).toBe(300);
    expect(result.expiresAt).toBe(new Date(claims.exp! * 1000).toISOString());
    query.mockResolvedValueOnce({ rows: [{ id: 'resident', route: 'GREEN', status: 'VERIFIED' }], rowCount: 1 });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const reservation = await authorizeUpload(token, 'resident', result.photoId, origin, secret, database);
    expect(reservation).toEqual({
      uid: 'resident', photoId: result.photoId, request: { ...request, byteSize: POLICY.maxPhotoBytes, ordinal: 5 },
      objectKey: `photos/${result.photoId}`,
      expiresAt: result.expiresAt,
    });
    expect(JSON.stringify(result)).not.toContain('photos/');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(query.mock.calls.flat().every((value) => !String(value).includes('INSERT'))).toBe(true);
  });

  it.each([
    { ...request, purpose: 'OTHER' }, { ...request, reportId }, { ...request, purpose: 'CLEANUP' },
    { ...request, mimeType: 'image/png' }, { ...request, byteSize: 0 },
    { ...request, byteSize: POLICY.maxPhotoBytes + 1 }, { ...request, byteSize: 1.5 },
    { ...request, ordinal: 0 }, { ...request, ordinal: 6 }, { ...request, ordinal: 1.5 },
    { ...request, userId: 'attacker' }, { ...request, photoId: reportId },
    { ...request, count: 6 }, { ...request, objectKey: 'attacker/key' }, [request],
    Array.from({ length: 6 }, () => request),
  ])('rejects invalid metadata before database access: %j', async (body) => {
    const { app, query } = setup();
    const response = await issue(app, body);
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('requires verified authentication and rejects cross-origin issuance', async () => {
    const { app, query, verify } = setup();
    for (const Authorization of ['', 'Bearer forged']) {
      const response = await app.request(`${origin}/api/uploads`, { method: 'POST', headers: { Authorization } }, env);
      expect(response.status).toBe(401);
    }
    verify.mockClear();
    const response = await app.request(`${origin}/api/uploads`, {
      method: 'POST', headers: { Authorization: 'Bearer resident', Origin: 'https://attacker.test' },
    }, env);
    expect(response.status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed without a signing key, HTTPS or the runtime database', async () => {
    const { app, query } = setup();
    for (const MEDIA_SIGNING_SECRET of ['', 'too-short']) {
      expect((await issue(app, request, { ...env, MEDIA_SIGNING_SECRET })).status).toBe(503);
    }
    const http = await app.request('http://iskra.test/api/uploads', {
      method: 'POST', headers: { Authorization: 'Bearer resident', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }, env);
    expect(http.status).toBe(503);
    const noDatabase = createApp({ verify: async () => ({ uid: 'resident' }) });
    expect((await issue(noDatabase)).status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a forged signature, wrong owner, photo ID, environment or signing key before SQL', async () => {
    const { app, database, query } = setup();
    const result = await ticket(app);
    query.mockClear();
    const pieces = result.token.split('.');
    pieces[2] = `${pieces[2][0] === 'a' ? 'b' : 'a'}${pieces[2].slice(1)}`;
    for (const [token, uid, photoId, audience, key] of [
      [pieces.join('.'), 'resident', result.photoId, origin, secret],
      [result.token, 'other', result.photoId, origin, secret],
      [result.token, 'resident', reportId, origin, secret],
      [result.token, 'resident', result.photoId, 'https://production.test', secret],
      [result.token, 'resident', result.photoId, origin, `${secret}-rotated`],
      ['', 'resident', result.photoId, origin, secret],
      ['x'.repeat(4097), 'resident', result.photoId, origin, secret],
    ]) {
      await expect(authorizeUpload(token, uid, photoId, audience, key, database)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['purpose', 'reportId', 'ordinal', 'byteSize', 'mimeType'])('rejects tampering with signed %s', async (field) => {
    const { app, database, query } = setup();
    const result = await ticket(app, { ...request, purpose: 'CLEANUP', reportId });
    const claims = decodeJwt(result.token);
    const data = claims.reservation as { request: Record<string, unknown> };
    data.request[field] = field === 'byteSize' || field === 'ordinal' ? 5 : 'tampered';
    const parts = result.token.split('.');
    parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
    query.mockClear();
    await expect(authorizeUpload(parts.join('.'), 'resident', result.photoId, origin, secret, database))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });

  it('expires exactly at five minutes and rejects future/extended signed tickets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, database, query } = setup();
    const result = await ticket(app);
    vi.setSystemTime(new Date(result.expiresAt));
    query.mockClear();
    await expect(authorizeUpload(result.token, 'resident', result.photoId, origin, secret, database))
      .rejects.toMatchObject({ code: 'EXPIRED', status: 410 });
    expect(query).not.toHaveBeenCalled();
    const now = Math.floor(Date.now() / 1000);
    for (const [iat, exp] of [[now, now + 301], [now + 1, now + 301]]) {
      const token = await new SignJWT({ reservation: decodeJwt(result.token).reservation })
        .setProtectedHeader({ alg: 'HS256', typ: 'iskra-upload+jwt' })
        .setIssuer('iskra:upload').setAudience(origin).setIssuedAt(iat).setExpirationTime(exp)
        .sign(new TextEncoder().encode(secret));
      await expect(authorizeUpload(token, 'resident', result.photoId, origin, secret, database))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('returns honest 503 without private storage', async () => {
    const { app, query } = setup();
    const result = await ticket(app);
    query.mockResolvedValueOnce({ rows: [{ id: 'resident', route: 'GREEN', status: 'VERIFIED' }], rowCount: 1 });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const response = await app.request(result.uploadUrl, {
      method: 'PUT', headers: { Authorization: 'Bearer resident', 'Content-Type': 'image/jpeg' }, body: 'not a JPEG',
    }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
    const denied = await app.request(result.uploadUrl, { method: 'PUT' }, env);
    expect(denied.status).toBe(401);
  });
});
