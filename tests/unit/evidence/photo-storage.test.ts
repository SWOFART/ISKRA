import { describe, expect, it, vi } from 'vitest';
import { vertexAuthJson, withVertexAuth } from '../../fixtures/ai/vertex';
import { createGooglePhotoStorage } from '../../../src/worker/services/photo-storage';

const bucket = 'iskra-test-staging-photos';
const key = 'photos/11111111-1111-4111-8111-111111111111';
const bytes = new Uint8Array([1, 2, 3]);
const options = { onlyIf: { etagDoesNotMatch: '*' as const }, httpMetadata: { contentType: 'image/jpeg' },
  customMetadata: { photoId: 'test-photo', sha256: 'test-hash' } };
const image = (body: Uint8Array<ArrayBuffer> = bytes) => new Response(body, {
  headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.length) },
});

describe('private Google photo storage', () => {
  it('creates metadata and JPEG bytes atomically with an absent-generation precondition, without overwriting', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const type = new Headers(init?.headers).get('Content-Type')!;
      const boundary = type.split('boundary=')[1];
      const body = new TextDecoder().decode(init?.body as Uint8Array);
      expect(type).toMatch(/^multipart\/related; boundary=iskra-/);
      expect(body).toContain(JSON.stringify({ name: key, contentType: 'image/jpeg', metadata: options.customMetadata }));
      expect(body).toContain('\r\n\r\n' + String.fromCharCode(...bytes) + '\r\n--' + boundary + '--');
      return Response.json({ size: '3' });
    });
    const storage = createGooglePhotoStorage(bucket, vertexAuthJson, withVertexAuth(fetcher));
    expect(await storage.put(key, bytes, options)).toEqual({ size: 3 });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://storage.googleapis.com/upload/storage/v1/b/' + bucket
      + '/o?uploadType=multipart&ifGenerationMatch=0&fields=size');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-only-vertex-access-token');
    fetcher.mockImplementation(async () => new Response('private-provider-detail', { status: 412 }));
    expect(await storage.put(key, bytes, options)).toBeNull();
  });

  it('shares request-scoped Google authentication across parallel private reads and returns only bounded image bytes', async () => {
    const auth = withVertexAuth(async () => image());
    const fetcher = vi.fn(auth);
    const storage = createGooglePhotoStorage(bucket, vertexAuthJson, fetcher);
    const photos = await Promise.all([storage.get(key), storage.get(key)]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('sts.googleapis.com'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('iamcredentials.googleapis.com'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith('https://storage.googleapis.com'))).toHaveLength(2);
    for (const photo of photos) {
      expect(photo?.size).toBe(3);
      expect(new Uint8Array(await photo!.arrayBuffer())).toEqual(bytes);
    }
    expect(String(fetcher.mock.calls.at(-1)![0])).toContain('/o/' + encodeURIComponent(key) + '?alt=media');
  });

  it('uses metadata for HEAD and treats missing reads/deletes as idempotent', async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ size: '3', contentType: 'image/jpeg' }));
    const storage = createGooglePhotoStorage(bucket, vertexAuthJson, withVertexAuth(fetcher));
    expect(await storage.head(key)).toEqual({ size: 3 });
    expect(String(fetcher.mock.calls[0][0])).toContain('?fields=size,contentType');
    fetcher.mockImplementation(async () => new Response(null, { status: 404 }));
    expect(await storage.get(key)).toBeNull();
    expect(await storage.head(key)).toBeNull();
    await expect(storage.delete(key)).resolves.toBeUndefined();
    expect(fetcher.mock.calls.at(-1)![1]?.method).toBe('DELETE');
  });

  it.each([302, 403, 429, 500])('redacts provider failures and never follows redirects (%s)', async (status) => {
    const fetcher = vi.fn(async () => new Response('private-provider-detail', {
      status, headers: { Location: 'https://foreign.invalid' },
    }));
    const storage = createGooglePhotoStorage(bucket, vertexAuthJson, withVertexAuth(fetcher));
    await expect(storage.get(key)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503,
      message: 'Photo storage is temporarily unavailable.' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['missing length', 'oversize', 'wrong MIME', 'short body', 'long body'] as const)(
    'rejects inconsistent media: %s', async (failure) => {
      const fetcher = vi.fn(async () => {
        const response = image();
        if (failure === 'missing length') response.headers.delete('Content-Length');
        if (failure === 'oversize') response.headers.set('Content-Length', '1048577');
        if (failure === 'wrong MIME') response.headers.set('Content-Type', 'text/html');
        if (failure === 'short body') response.headers.set('Content-Length', '4');
        if (failure === 'long body') response.headers.set('Content-Length', '2');
        return response;
      });
      const storage = createGooglePhotoStorage(bucket, vertexAuthJson, withVertexAuth(fetcher));
      await expect((async () => (await storage.get(key))?.arrayBuffer())()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

  it('bounds metadata responses and rejects unexpected upload receipts', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(65_537)));
    const storage = createGooglePhotoStorage(bucket, vertexAuthJson, withVertexAuth(fetcher));
    await expect(storage.head(key)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    fetcher.mockImplementation(async () => Response.json({ size: '4' }));
    await expect(storage.put(key, bytes, options)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('fails closed without valid Google identity or with oversized bytes before storage access', async () => {
    const fetcher = vi.fn(async () => image());
    await expect(createGooglePhotoStorage(bucket, '{}', fetcher).get(key)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(createGooglePhotoStorage(bucket, vertexAuthJson, fetcher)
      .put(key, new Uint8Array(1_048_577), options)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
