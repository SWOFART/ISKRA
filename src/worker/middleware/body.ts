import { createMiddleware } from 'hono/factory';
import type { WorkerEnv } from './context';
import { ApiError } from './errors';
import { POLICY } from '../../shared/contracts';

export async function readBoundedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
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
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'image/jpeg') {
          throw new ApiError(413, 'PHOTO_TOO_LARGE', 'Photo is too large.');
        }
        throw new ApiError(400, 'INVALID_INPUT', 'Request body is too large.');
      }
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export const boundedBody = createMiddleware<WorkerEnv>(async (c, next) => {
  // Uploads read through the same byte limit after authentication and ticket admission.
  if (c.req.method === 'PUT' && /^\/api\/uploads\/[^/]+\/content$/.test(c.req.path)) return next();
  if (!c.req.raw.body) return next();
  const bytes = await readBoundedBody(c.req.raw);
  c.req.raw = new Request(c.req.raw, { body: bytes });
  await next();
});
