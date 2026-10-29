import { POLICY } from '../../shared/contracts';
import { ApiError } from '../middleware/errors';
import { googleAccessToken, parseGoogleIdentity, readGoogleJson } from './google-auth';

/** The operations used by evidence routes; provider URLs never reach residents. */
export interface PhotoStorage {
  get(key: string): Promise<{
    size: number; body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, bytes: Uint8Array<ArrayBuffer>, options: {
    onlyIf: { etagDoesNotMatch: '*' };
    httpMetadata: { contentType: string };
    customMetadata: Record<string, string>;
  }): Promise<object | null>;
  delete(key: string): Promise<void>;
}

const unavailable = () => new ApiError(503, 'UNAVAILABLE', 'Photo storage is temporarily unavailable.', true);

function photoSize(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,6}$/.test(value)
    || Number(value) > POLICY.maxPhotoBytes) throw unavailable();
  return Number(value);
}

/** One request-scoped Google token is shared by parallel photo reads. */
export function createGooglePhotoStorage(bucket: string, authJson: string, fetcher: typeof fetch = fetch): PhotoStorage {
  let token: Promise<string> | undefined;
  const objectPath = (key: string) => '/storage/v1/b/' + encodeURIComponent(bucket) + '/o/' + encodeURIComponent(key);
  async function request(path: string, init: RequestInit = {}) {
    try {
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw unavailable();
      const signal = AbortSignal.timeout(10_000);
      token ??= googleAccessToken(parseGoogleIdentity(authJson), fetcher, signal);
      const headers = new Headers(init.headers);
      headers.set('Authorization', 'Bearer ' + await token);
      const response = await fetcher('https://storage.googleapis.com' + path, {
        ...init, headers, redirect: 'manual', signal,
      });
      if (![200, 201, 204, 404, 412].includes(response.status)) {
        await response.body?.cancel(); throw unavailable();
      }
      return response;
    } catch { throw unavailable(); }
  }
  async function metadata(response: Response) {
    try { return await readGoogleJson(response); } catch { throw unavailable(); }
  }
  return {
    async get(key) {
      const response = await request(objectPath(key) + '?alt=media');
      if (response.status === 404) { await response.body?.cancel(); return null; }
      let size: number;
      try {
        if (response.status !== 200 || response.headers.get('Content-Type')?.split(';')[0] !== 'image/jpeg') throw unavailable();
        size = photoSize(response.headers.get('Content-Length'));
        if (!response.body) throw unavailable();
      } catch { await response.body?.cancel(); throw unavailable(); }
      const reader = response.body!.getReader(); let length = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              if (length !== size) throw unavailable();
              controller.close();
            } else {
              length += next.value.byteLength;
              if (length > size) throw unavailable();
              controller.enqueue(next.value);
            }
          } catch {
            void reader.cancel().catch(() => {}); controller.error(unavailable());
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return { size, body, arrayBuffer: () => new Response(body).arrayBuffer() };
    },
    async head(key) {
      const response = await request(objectPath(key) + '?fields=size,contentType');
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (response.status !== 200) { await response.body?.cancel(); throw unavailable(); }
      const object = await metadata(response);
      if (object.contentType !== 'image/jpeg') throw unavailable();
      return { size: photoSize(object.size) };
    },
    async put(key, bytes, options) {
      if (options.onlyIf.etagDoesNotMatch !== '*' || options.httpMetadata.contentType !== 'image/jpeg'
        || bytes.length < 1 || bytes.length > POLICY.maxPhotoBytes) throw unavailable();
      const boundary = 'iskra-' + crypto.randomUUID();
      const prefix = new TextEncoder().encode('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
        + JSON.stringify({ name: key, contentType: 'image/jpeg', metadata: options.customMetadata })
        + '\r\n--' + boundary + '\r\nContent-Type: image/jpeg\r\n\r\n');
      const suffix = new TextEncoder().encode('\r\n--' + boundary + '--\r\n');
      const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
      body.set(prefix); body.set(bytes, prefix.length); body.set(suffix, prefix.length + bytes.length);
      const response = await request('/upload/storage/v1/b/' + encodeURIComponent(bucket)
        + '/o?uploadType=multipart&ifGenerationMatch=0&fields=size', {
        method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
      });
      if (response.status === 412) { await response.body?.cancel(); return null; }
      if (![200, 201].includes(response.status)) { await response.body?.cancel(); throw unavailable(); }
      if (photoSize((await metadata(response)).size) !== bytes.length) throw unavailable();
      return { size: bytes.length };
    },
    async delete(key) {
      const response = await request(objectPath(key), { method: 'DELETE' });
      await response.body?.cancel();
      if (![204, 404].includes(response.status)) throw unavailable();
    },
  };
}
