import { createMiddleware } from 'hono/factory';
import type { WorkerEnv } from './context';
import { ApiError } from './errors';

export const boundedBody = createMiddleware<WorkerEnv>(async (c, next) => {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return next();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1_048_576) {
        throw new ApiError(413, 'INVALID_INPUT', 'Request body is too large.');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  // Count actual bytes even if a caller supplies a smaller Content-Length.
  c.req.raw = new Request(c.req.raw, { body: bytes });
  await next();
});
