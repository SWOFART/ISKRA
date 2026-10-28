import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadTicketSchema } from '../../../src/shared/contracts';
import { createApp } from '../../../src/worker/index';
import type { TransactionDatabase } from '../../../src/worker/db/client';

const jpeg = new Uint8Array(readFileSync(new URL('../../fixtures/photos/grayscale.jpg', import.meta.url)));
const secret = 'test-only-upload-signing-key-at-least-32-bytes';
afterEach(() => vi.useRealTimers());

function setup() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const put = vi.fn(async (key: string, bytes: Uint8Array<ArrayBuffer>) => {
    if (objects.has(key)) return null;
    objects.set(key, bytes.slice());
    return { key };
  });
  const query = vi.fn(async (sql: string, _parameters?: readonly unknown[]) => ({
    rows: sql.startsWith('SELECT id FROM report_photos') ? [] : [{ id: 'resident', route: 'GREEN', status: 'VERIFIED' }],
    rowCount: 1,
  }));
  const database: TransactionDatabase = { withTransaction: (work) => work({ query: query as never }) };
  const env = { FIREBASE_PROJECT_ID: 'iskra-test', MEDIA_SIGNING_SECRET: secret, PHOTOS: { put } as unknown as R2Bucket };
  const app = createApp({ database, verify: async (token) => ({ uid: token }) });
  const upload = async (url: string, body = jpeg, type = 'image/jpeg', token = 'resident') => app.request(url, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
    body: body.slice().buffer,
  }, env);
  const issue = async (request = {}) => {
    const response = await app.request('https://iskra.test/api/uploads', {
      method: 'POST', headers: { Authorization: 'Bearer resident', 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'REPORT', mimeType: 'image/jpeg', byteSize: jpeg.length, ordinal: 1, ...request }),
    }, env);
    expect(response.status).toBe(201);
    return UploadTicketSchema.parse(await response.json());
  };
  return { app, env, upload, issue, objects, put, query };
}

describe('immutable report JPEG finalization', () => {
  it('stores sanitized content conditionally before recording its actual hash/size and zero-based ordinal', async () => {
    const { issue, upload, objects, put, query } = setup();
    const ticket = await issue({ ordinal: 5 });
    const response = await upload(ticket.uploadUrl);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ photoId: ticket.photoId, state: 'UPLOADED' });
    const bytes = objects.get(`photos/${ticket.photoId}`)!;
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    expect(put).toHaveBeenCalledWith(`photos/${ticket.photoId}`, bytes, {
      onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'image/jpeg' },
      customMetadata: { photoId: ticket.photoId, sha256: hash, expiresAt: ticket.expiresAt },
    });
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO report_photos'))!;
    expect(insert[1]).toEqual([ticket.photoId, 'resident', `photos/${ticket.photoId}`, 4, bytes.length, hash, ticket.expiresAt]);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('rejects a different owner and ambiguous query strings before storage', async () => {
    const { issue, upload, put } = setup();
    const ticket = await issue();
    for (const url of [ticket.uploadUrl + '&ticket=other', ticket.uploadUrl + '&extra=1']) {
      expect((await upload(url)).status).toBe(403);
    }
    expect((await upload(ticket.uploadUrl, jpeg, 'image/jpeg', 'other')).status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });

  it('authenticates before reading the upload stream', async () => {
    const { app, env, issue, put } = setup();
    const ticket = await issue();
    const raw = new Request(ticket.uploadUrl, { method: 'PUT', body: jpeg });
    const read = vi.spyOn(raw.body!, 'getReader');
    expect((await app.fetch(raw, env)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a ticket that expires while its body is arriving', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, env, issue, put } = setup();
    const ticket = await issue();
    const body = new ReadableStream({ pull(controller) {
      vi.setSystemTime(new Date(ticket.expiresAt));
      controller.enqueue(jpeg);
      controller.close();
    } }, { highWaterMark: 0 });
    const raw = new Request(ticket.uploadUrl, {
      method: 'PUT', headers: { Authorization: 'Bearer resident', 'Content-Type': 'image/jpeg' },
      body, duplex: 'half',
    } as RequestInit);
    expect((await app.fetch(raw, env)).status).toBe(410);
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects mismatched size, MIME forgery, malformed JPEG and oversize streamed bytes before writes', async () => {
    const { issue, upload, put, query } = setup();
    const ticket = await issue();
    expect((await upload(ticket.uploadUrl, jpeg.slice(0, -1))).status).toBe(400);
    expect((await upload(ticket.uploadUrl, jpeg, 'image/png')).status).toBe(415);
    expect((await upload(ticket.uploadUrl, new Uint8Array(jpeg.length))).status).toBe(415);
    expect((await upload(ticket.uploadUrl, new Uint8Array(1_048_577))).status).toBe(413);
    expect(put).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('does not overwrite when concurrent PUTs use the same ticket', async () => {
    const { issue, upload, put, query } = setup();
    const ticket = await issue();
    const responses = await Promise.all([upload(ticket.uploadUrl), upload(ticket.uploadUrl)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(put).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT'))).toHaveLength(1);
  });

  it('returns a safe storage failure without SQL evidence', async () => {
    const { issue, upload, put, query } = setup();
    const ticket = await issue();
    put.mockRejectedValueOnce(new Error('private storage credentials'));
    const response = await upload(ticket.uploadUrl);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('credentials');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('keeps cleanup writes disabled pending durable target agreement', async () => {
    const { issue, upload, put } = setup();
    const ticket = await issue({ purpose: 'CLEANUP', reportId: crypto.randomUUID() });
    expect((await upload(ticket.uploadUrl)).status).toBe(503);
    expect(put).not.toHaveBeenCalled();
  });
});
