import { POLICY } from '../src/shared/contracts';

interface DemoSeedR2Environment {
  readonly DEMO_PHOTOS: R2Bucket;
  readonly DEMO_SEED_TOKEN?: string;
}

const controlledKey = /^demo-fixtures\/seed-v1\/(?:green-resolved\/(?:before|after)|yellow-pending\/before|red-pending\/before)-([0-9a-f]{64})\.jpg$/;

function response(status: number, body?: Record<string, string | number>) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
  });
}

async function readBoundedPhoto(request: Request): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > POLICY.maxPhotoBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function readStoredPhoto(bucket: R2Bucket, key: string): Promise<Uint8Array | null> {
  const stored = await bucket.get(key);
  return stored ? new Uint8Array(await stored.arrayBuffer()) : null;
}

function isMatchingPhoto(bytes: Uint8Array | null, byteSize: number): boolean {
  return bytes !== null && bytes.byteLength === byteSize;
}

async function replyForStoredPhoto(
  bucket: R2Bucket,
  key: string,
  body: Uint8Array,
  expectedSha256: string,
  status: number,
): Promise<Response> {
  const storedBytes = await readStoredPhoto(bucket, key);
  if (!isMatchingPhoto(storedBytes, body.byteLength)
    || await sha256(storedBytes!) !== expectedSha256) {
    return response(409, { error: 'DEMO_PHOTO_CONFLICT' });
  }
  return response(status, { outcome: status === 201 ? 'created' : 'already-present', byteSize: body.byteLength, sha256: expectedSha256 });
}

export default {
  async fetch(request: Request, env: DemoSeedR2Environment): Promise<Response> {
    const authorization = request.headers.get('Authorization');
    if (!env.DEMO_SEED_TOKEN || authorization !== `Bearer ${env.DEMO_SEED_TOKEN}`) {
      return response(404, { error: 'NOT_FOUND' });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return response(204);
    if (url.pathname !== '/photos' || request.method !== 'PUT') return response(404, { error: 'NOT_FOUND' });
    if (url.searchParams.getAll('key').length !== 1) return response(400, { error: 'INVALID_PHOTO_KEY' });

    const key = url.searchParams.get('key')!;
    const keyMatch = controlledKey.exec(key);
    if (!keyMatch) return response(400, { error: 'INVALID_PHOTO_KEY' });
    if (request.headers.get('Content-Type') !== 'image/jpeg') return response(415, { error: 'UNSUPPORTED_MEDIA' });
    const declaredSize = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declaredSize) && declaredSize > POLICY.maxPhotoBytes) {
      return response(413, { error: 'PHOTO_TOO_LARGE' });
    }

    const body = await readBoundedPhoto(request);
    if (body === null) return response(413, { error: 'PHOTO_TOO_LARGE' });
    if (!body.byteLength || await sha256(body) !== keyMatch[1]) return response(400, { error: 'PHOTO_HASH_MISMATCH' });

    const existingBytes = await readStoredPhoto(env.DEMO_PHOTOS, key);
    if (existingBytes) {
      if (!isMatchingPhoto(existingBytes, body.byteLength)
        || await sha256(existingBytes) !== keyMatch[1]) {
        return response(409, { error: 'DEMO_PHOTO_CONFLICT' });
      }
      return replyForStoredPhoto(env.DEMO_PHOTOS, key, body, keyMatch[1], 200);
    }

    const created = await env.DEMO_PHOTOS.put(key, body, {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType: 'image/jpeg' },
      customMetadata: { sha256: keyMatch[1], source: 'controlled-demo-fixture' },
    });
    if (!created) {
      return replyForStoredPhoto(env.DEMO_PHOTOS, key, body, keyMatch[1], 200);
    }
    return replyForStoredPhoto(env.DEMO_PHOTOS, key, body, keyMatch[1], 201);
  },
};
