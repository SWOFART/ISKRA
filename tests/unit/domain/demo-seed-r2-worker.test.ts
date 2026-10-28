import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import seedR2Worker from '../../../scripts/demo-seed-r2-worker';
import { ensureLocalDemoPhotoObjects } from '../../../scripts/demo-photo-storage';
import { demoSeedPhotoObjectKeys } from '../../../src/worker/services/demo-seeds';

const photoBytes = await readFile(new URL('../../../tests/fixtures/photos/restart.jpg', import.meta.url));
const photoSha256 = createHash('sha256').update(photoBytes).digest('hex');
const photoKey = demoSeedPhotoObjectKeys(photoSha256).greenBefore;
const token = 'local-demo-seed-token';
type SeedR2Binding = Parameters<typeof seedR2Worker.fetch>[1]['DEMO_PHOTOS'];

function createBucket() {
  const objects = new Map<string, Uint8Array>();
  let insertOnNextMiss: Uint8Array | undefined;
  const bucket = {
    async get(key: string) {
      let existing = objects.get(key);
      if (!existing && insertOnNextMiss) {
        objects.set(key, insertOnNextMiss);
        insertOnNextMiss = undefined;
        return null;
      }
      if (!existing) return null;
      existing = new Uint8Array(existing);
      return { arrayBuffer: async () => existing!.slice().buffer };
    },
    async put(key: string, value: Uint8Array, options?: { onlyIf?: Headers }) {
      if (options?.onlyIf?.get('If-None-Match') === '*' && objects.has(key)) return null;
      objects.set(key, new Uint8Array(value));
      return {};
    },
    injectDifferentObjectOnNextMiss(bytes: Uint8Array) {
      insertOnNextMiss = new Uint8Array(bytes);
    },
    objects,
  };
  return bucket;
}

function uploadRequest(bytes: Uint8Array = photoBytes, key = photoKey, authorized = true) {
  return new Request(`http://127.0.0.1/photos?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      Authorization: authorized ? `Bearer ${token}` : 'Bearer wrong-token',
      'Content-Type': 'image/jpeg',
    },
    body: Buffer.from(bytes),
  });
}

describe('local demo photo R2 Worker', () => {
  it('creates the controlled photo once and safely accepts an identical retry', async () => {
    const bucket = createBucket();
    const env = { DEMO_PHOTOS: bucket as unknown as R2Bucket, DEMO_SEED_TOKEN: token };

    const first = await seedR2Worker.fetch(uploadRequest(), env);
    const retry = await seedR2Worker.fetch(uploadRequest(), env);

    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ outcome: 'created', byteSize: photoBytes.byteLength, sha256: photoSha256 });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ outcome: 'already-present', byteSize: photoBytes.byteLength, sha256: photoSha256 });
    expect([...bucket.objects.get(photoKey)!]).toEqual([...photoBytes]);
  });

  it('refuses a mismatched existing object without replacing its bytes', async () => {
    const bucket = createBucket();
    const differentBytes = new Uint8Array([1, 2, 3]);
    bucket.objects.set(photoKey, differentBytes);
    const env = { DEMO_PHOTOS: bucket as unknown as SeedR2Binding, DEMO_SEED_TOKEN: token };

    const result = await seedR2Worker.fetch(uploadRequest(), env);

    expect(result.status).toBe(409);
    expect([...bucket.objects.get(photoKey)!]).toEqual([...differentBytes]);
  });

  it('uses an atomic create precondition when a conflicting object appears after the miss', async () => {
    const bucket = createBucket();
    const competingBytes = new Uint8Array([4, 5, 6]);
    bucket.injectDifferentObjectOnNextMiss(competingBytes);
    const env = { DEMO_PHOTOS: bucket as unknown as R2Bucket, DEMO_SEED_TOKEN: token };

    const result = await seedR2Worker.fetch(uploadRequest(), env);

    expect(result.status).toBe(409);
    expect([...bucket.objects.get(photoKey)!]).toEqual([...competingBytes]);
  });

  it('only accepts authenticated uploads to the fixed controlled-key namespace', async () => {
    const bucket = createBucket();
    const env = { DEMO_PHOTOS: bucket as unknown as SeedR2Binding, DEMO_SEED_TOKEN: token };

    expect((await seedR2Worker.fetch(uploadRequest(photoBytes, photoKey, false), env)).status).toBe(404);
    expect((await seedR2Worker.fetch(uploadRequest(photoBytes, '../production/photo.jpg'), env)).status).toBe(400);
    expect(bucket.objects.size).toBe(0);
  });

  it('stores and reads back all four fixtures through Wrangler local R2, including an identical replay', async () => {
    const photo = { byteSize: photoBytes.byteLength, sha256: photoSha256 };
    await expect(ensureLocalDemoPhotoObjects(photoBytes, photo)).resolves.toBe(4);
    await expect(ensureLocalDemoPhotoObjects(photoBytes, photo)).resolves.toBe(4);
  }, 30_000);
});
