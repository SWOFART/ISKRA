import { Hono } from 'hono';
import type { TransactionDatabase } from '../db/client';
import { optionalAuth, requireAuth, type verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { authorizePhotoRead, createOwnerPhotoPreview } from '../services/media';
import { POLICY, UuidSchema } from '../../shared/contracts';

export function createPhotoRoutes({ database, verify }: {
  database?: TransactionDatabase;
  verify?: typeof verifyFirebaseToken;
} = {}) {
  const routes = new Hono<WorkerEnv>();
  routes.get('/photos/:id', requireAuth(verify), async (c) => {
    const id = UuidSchema.safeParse(c.req.param('id'));
    if (!id.success || new URL(c.req.url).search) throw new ApiError(400, 'INVALID_INPUT', 'Invalid photo lookup.');
    if (!database || !c.env.PHOTOS) throw new ApiError(503, 'UNAVAILABLE', 'Photo storage is not configured.');
    return c.json(await createOwnerPhotoPreview(database, id.data.toLowerCase(), c.get('identity')!.uid,
      new URL(c.req.url).origin, c.env.MEDIA_SIGNING_SECRET));
  });
  routes.on(['GET', 'HEAD'], '/photos/:id/content', optionalAuth(verify), async (c) => {
    if (!database || !c.env.PHOTOS) throw new ApiError(503, 'UNAVAILABLE', 'Photo storage is not configured.');
    const tokens = c.req.queries('token');
    if (tokens?.length !== 1 || [...new URL(c.req.url).searchParams.keys()].some((key) => key !== 'token')) {
      throw new ApiError(403, 'FORBIDDEN', 'Invalid photo access.');
    }
    const photo = await authorizePhotoRead(database, c.req.param('id'), tokens[0],
      new URL(c.req.url).origin, c.env.MEDIA_SIGNING_SECRET, c.get('identity')?.uid);
    try {
      let body: ReadableStream | null = null;
      let object: R2Object | null;
      if (c.req.method === 'HEAD') object = await c.env.PHOTOS.head(photo.object_key);
      else {
        const content = await c.env.PHOTOS.get(photo.object_key);
        object = content;
        body = content?.body ?? null;
      }
      if (!object) throw new ApiError(404, 'NOT_FOUND', 'Photo not found.');
      if (object.size !== photo.byte_size || object.size < 1 || object.size > POLICY.maxPhotoBytes) {
        await body?.cancel();
        throw new ApiError(503, 'UNAVAILABLE', 'Photo content is temporarily unavailable.');
      }
      c.header('Content-Type', 'image/jpeg');
      c.header('Content-Length', String(object.size));
      c.header('Content-Disposition', 'inline');
      return body ? c.body(body) : c.body(null);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'UNAVAILABLE', 'Photo content is temporarily unavailable.');
    }
  });
  return routes;
}
