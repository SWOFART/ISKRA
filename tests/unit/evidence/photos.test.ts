import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createApp, createWorkerHandler } from '../../../src/worker';
import type { TransactionDatabase } from '../../../src/worker/db/client';
import type { StoredPhoto } from '../../../src/worker/db/evidence-store';
import { authorizePhotoRead, createPhotoReadCapability, createReportMediaResolver } from '../../../src/worker/services/media';

const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const origin = 'https://iskra.test';
const secret = 'unit-photo-signing-secret-at-least-32-bytes';
const ref = { id, ordinal: 1, purpose: 'REPORT' as const };
const stored: StoredPhoto = {
  id, owner_user_id: 'owner', object_key: 'private/stored-object', byte_size: 3,
  state: 'ATTACHED', published: true,
};
function fixture(photo: StoredPhoto | null = stored) {
  const query = vi.fn(async () => ({ rows: photo ? [photo] : [], rowCount: photo ? 1 : 0 }));
  const database = { withTransaction: (work: (client: unknown) => unknown) => work({ query }) } as TransactionDatabase;
  const get = vi.fn(async () => ({ size: 3, body: new Response(new Uint8Array([1, 2, 3])).body }));
  const head = vi.fn(async () => ({ size: 3 }));
  const bucket = { get, head, delete: vi.fn() } as unknown as R2Bucket;
  const app = createApp({ database, verify: async (token) => ({ uid: token }) });
  return { database, query, get, head, bucket, app };
}
function token(url: string) { return new URL(url).searchParams.get('token')!; }
afterEach(() => vi.useRealTimers());

describe('private photo capabilities', () => {
  it('creates ordered, five-minute, same-origin links and refreshes them without exposing storage keys', async () => {
    const media = createReportMediaResolver(origin, secret);
    const now = Date.now();
    const photos = await media.resolveAttachedPhotos([ref, { id: otherId, ordinal: 2, purpose: 'CLEANUP' }]);
    expect(photos.map((photo) => photo.ordinal)).toEqual([1, 2]);
    expect(photos[0].mediaUrl).toContain(`${origin}/api/photos/${id}/content?token=`);
    expect(photos[0].mediaUrl).not.toContain('private/');
    expect(Date.parse(photos[0].expiresAt) - now).toBeGreaterThan(298_000);
    expect(Date.parse(photos[0].expiresAt) - now).toBeLessThanOrEqual(300_000);
    vi.useFakeTimers(); vi.setSystemTime(now + 301_000);
    const refreshed = await media.resolveAttachedPhotos([ref]);
    expect(refreshed[0].mediaUrl).not.toBe(photos[0].mediaUrl);
    expect(Date.parse(refreshed[0].expiresAt)).toBeGreaterThan(Date.now());
  });

  it('rejects tampering, another photo/origin/key and expired links before SQL/storage', async () => {
    const { database, query } = fixture();
    const photo = await createPhotoReadCapability(ref, origin, secret);
    const valid = token(photo.mediaUrl);
    for (const [photoId, capability, audience, key] of [
      [id, valid.slice(0, -8) + 'tampered', origin, secret],
      [otherId, valid, origin, secret], [id, valid, 'https://other.test', secret],
      [id, valid, origin, secret + 'changed'],
    ]) {
      await expect(authorizePhotoRead(database, photoId, capability, audience, key))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 301_000);
    await expect(authorizePhotoRead(database, id, valid, origin, secret)).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not accept a longer-lived signed capability', async () => {
    const { database, query } = fixture();
    const iat = Math.floor(Date.now() / 1000);
    const capability = await new SignJWT({ access: { scope: 'PUBLIC', photoId: id } })
      .setProtectedHeader({ alg: 'HS256', typ: 'iskra-photo+jwt' }).setIssuer('iskra:photo')
      .setAudience(origin).setIssuedAt(iat).setExpirationTime(iat + 3600)
      .sign(new TextEncoder().encode(secret));
    await expect(authorizePhotoRead(database, id, capability, origin, secret)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });

  it('requires owner authentication for unattached previews and rechecks current publication', async () => {
    const { database } = fixture({ ...stored, state: 'UPLOADED', published: false });
    const owner = await createPhotoReadCapability(ref, origin, secret, 'owner');
    for (const uid of [undefined, 'other']) {
      await expect(authorizePhotoRead(database, id, token(owner.mediaUrl), origin, secret, uid))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(authorizePhotoRead(database, id, token(owner.mediaUrl), origin, secret, 'owner')).resolves.toMatchObject({ id });
    const guest = await createPhotoReadCapability(ref, origin, secret);
    await expect(authorizePhotoRead(database, id, token(guest.mediaUrl), origin, secret)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('never serves missing or reserved content and fails closed on missing signing configuration', async () => {
    const photo = await createPhotoReadCapability(ref, origin, secret, 'owner');
    for (const row of [null, { ...stored, state: 'RESERVED' as const }]) {
      await expect(authorizePhotoRead(fixture(row).database, id, token(photo.mediaUrl), origin, secret, 'owner'))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    await expect(createPhotoReadCapability(ref, origin, undefined)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(createPhotoReadCapability(ref, 'http://iskra.test', secret)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('Worker photo delivery', () => {
  it('serves a published JPEG to guests with no-store/no-referrer and HEAD without reading bytes', async () => {
    const f = fixture();
    const photo = await createPhotoReadCapability(ref, origin, secret);
    const env = { PHOTOS: f.bucket, MEDIA_SIGNING_SECRET: secret };
    const response = await f.app.request(photo.mediaUrl, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-length')).toBe('3');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const head = await f.app.request(photo.mediaUrl, { method: 'HEAD' }, env);
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect(f.get).toHaveBeenCalledOnce(); expect(f.head).toHaveBeenCalledOnce();
    expect(f.get).toHaveBeenCalledWith(stored.object_key);
  });

  it('denies guest/private access, duplicate tokens and listings without object reads', async () => {
    const f = fixture({ ...stored, state: 'UPLOADED', published: false });
    const owner = await createPhotoReadCapability(ref, origin, secret, 'owner');
    const env = { PHOTOS: f.bucket, MEDIA_SIGNING_SECRET: secret, FIREBASE_PROJECT_ID: 'iskra-test' };
    expect((await f.app.request(owner.mediaUrl, {}, env)).status).toBe(403);
    expect((await f.app.request(owner.mediaUrl + '&token=duplicate', {}, env)).status).toBe(403);
    expect((await f.app.request(origin + '/api/photos', {}, env)).status).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
    expect((await f.app.request(owner.mediaUrl, { headers: { Authorization: 'Bearer owner' } }, env)).status).toBe(200);
  });

  it('redacts storage errors and rejects missing or mismatched content', async () => {
    const f = fixture();
    const photo = await createPhotoReadCapability(ref, origin, secret);
    const env = { PHOTOS: f.bucket, MEDIA_SIGNING_SECRET: secret };
    f.get.mockRejectedValueOnce(new Error('secret storage URL/token'));
    const unavailable = await f.app.request(photo.mediaUrl, {}, env);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('secret');
    f.get.mockResolvedValueOnce(null as never);
    expect((await f.app.request(photo.mediaUrl, {}, env)).status).toBe(404);
    f.get.mockResolvedValueOnce({ size: 4, body: new Response('bad!').body });
    expect((await f.app.request(photo.mediaUrl, {}, env)).status).toBe(503);
  });

  it('uses request-scoped storage/database at runtime and closes the database', async () => {
    const f = fixture(); const close = vi.fn(async () => {});
    const createDatabase = vi.fn(() => ({ database: f.database, close }));
    const worker = createWorkerHandler({ createDatabase });
    const photo = await createPhotoReadCapability(ref, origin, secret);
    const response = await worker.fetch(new Request(photo.mediaUrl), {
      PHOTOS: f.bucket, MEDIA_SIGNING_SECRET: secret,
      HYPERDRIVE: { connectionString: 'postgres://fixture/iskra' },
    }, {} as ExecutionContext);
    expect(response.status).toBe(200); expect(close).toHaveBeenCalledOnce();
    await expect(worker.scheduled({} as ScheduledController, {})).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
