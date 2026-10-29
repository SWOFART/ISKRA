import { Hono } from 'hono';
import { errors, jwtVerify, SignJWT } from 'jose';
import { POLICY, UidSchema, UploadRequestSchema, UploadResultSchema, UploadTicketSchema, UuidSchema } from '../../shared/contracts';
import { object } from '../../shared/schema';
import { admitUpload, assertUploadRate, evidenceQuota, finalizeReportPhoto } from '../db/evidence-store';
import type { TransactionDatabase } from '../db/client';
import { requireAuth, verifyFirebaseToken } from '../middleware/auth';
import type { WorkerEnv } from '../middleware/context';
import { ApiError } from '../middleware/errors';
import { parseJsonBody } from '../middleware/validation';
import { readBoundedBody } from '../middleware/body';
import { prepareJpeg } from '../services/media';

const TICKET_SECONDS = 300;
const ISSUER = 'iskra:upload';
const TYPE = 'iskra-upload+jwt';
const ReservationSchema = object({
  uid: UidSchema, photoId: UuidSchema, request: UploadRequestSchema,
});

function signingKey(secret: string | undefined) {
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new ApiError(503, 'UNAVAILABLE', 'Upload signing is not configured.', true);
  }
  return new TextEncoder().encode(secret);
}

/** Verify admission before reading bytes, then finalize the same photo ID once. */
export async function authorizeUpload(
  token: string | undefined,
  uid: string,
  photoId: string,
  origin: string,
  secret: string | undefined,
  database: TransactionDatabase,
) {
  const key = signingKey(secret);
  if (!token || token.length > 4096 || !UuidSchema.safeParse(photoId).success) {
    throw new ApiError(403, 'FORBIDDEN', 'Invalid upload ticket.');
  }
  let reservation;
  let expiresAt: string;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'], issuer: ISSUER, audience: origin, typ: TYPE,
      requiredClaims: ['iat', 'exp'],
    });
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.iat! > now || payload.exp! - payload.iat! !== TICKET_SECONDS) {
      throw new Error('Invalid ticket lifetime');
    }
    reservation = ReservationSchema.parse(payload.reservation);
    expiresAt = new Date(payload.exp! * 1000).toISOString();
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new ApiError(410, 'EXPIRED', 'Upload ticket expired. Request a new ticket.', true);
    }
    throw new ApiError(403, 'FORBIDDEN', 'Invalid upload ticket.');
  }
  if (reservation.uid !== uid || reservation.photoId !== photoId) {
    throw new ApiError(403, 'FORBIDDEN', 'Invalid upload ticket.');
  }
  await admitUpload(database, uid, reservation.request, photoId);
  return { ...reservation, objectKey: `photos/${reservation.photoId}`, expiresAt };
}

export function createUploadRoutes({ database, verify }: {
  database?: TransactionDatabase;
  verify?: typeof verifyFirebaseToken;
} = {}) {
  const routes = new Hono<WorkerEnv>();
  routes.post('/uploads', requireAuth(verify), async (c) => {
    if (evidenceQuota(c.env.AI_RATE_PER_MINUTE, 10) === 0) {
      throw new ApiError(503, 'UNAVAILABLE', 'Photo uploads are temporarily paused.', true);
    }
    const request = await parseJsonBody(c, UploadRequestSchema);
    const key = signingKey(c.env.MEDIA_SIGNING_SECRET);
    if (!database) throw new ApiError(503, 'UNAVAILABLE', 'Upload storage is not integrated yet.', true);
    const url = new URL(c.req.url);
    if (url.protocol !== 'https:') {
      throw new ApiError(503, 'UNAVAILABLE', 'Uploads require an HTTPS application origin.', true);
    }
    const uid = c.get('identity')!.uid;
    await admitUpload(database, uid, request);
    const photoId = crypto.randomUUID();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + TICKET_SECONDS;
    const ticket = await new SignJWT({ reservation: { uid, photoId, request } })
      .setProtectedHeader({ alg: 'HS256', typ: TYPE })
      .setIssuer(ISSUER).setAudience(url.origin).setIssuedAt(issuedAt).setExpirationTime(expiresAt)
      .sign(key);
    url.pathname = `/api/uploads/${photoId}/content`;
    url.search = '';
    url.searchParams.set('ticket', ticket);
    return c.json(UploadTicketSchema.parse({
      photoId, uploadUrl: url.href, expiresAt: new Date(expiresAt * 1000).toISOString(),
      maxBytes: POLICY.maxPhotoBytes,
    }), 201);
  });
  routes.put('/uploads/:id/content', requireAuth(verify), async (c) => {
    if (!database) throw new ApiError(503, 'UNAVAILABLE', 'Upload storage is not integrated yet.', true);
    const url = new URL(c.req.url);
    if (url.searchParams.size !== 1 || url.searchParams.getAll('ticket').length !== 1) {
      throw new ApiError(403, 'FORBIDDEN', 'Invalid upload ticket.');
    }
    const uid = c.get('identity')!.uid;
    const uploadLimit = evidenceQuota(c.env.AI_RATE_PER_MINUTE, 10);
    if (uploadLimit === 0) throw new ApiError(503, 'UNAVAILABLE', 'Photo uploads are temporarily paused.', true);
    const reservation = await authorizeUpload(c.req.query('ticket'), uid, c.req.param('id'),
      new URL(c.req.url).origin, c.env.MEDIA_SIGNING_SECRET, database);
    await assertUploadRate(database, uid, uploadLimit);
    if (!c.env.PHOTOS) throw new ApiError(503, 'UNAVAILABLE', 'Photo storage is not integrated yet.', true);
    const input = await readBoundedBody(c.req.raw);
    if (input.byteLength !== reservation.request.byteSize) {
      throw new ApiError(400, 'INVALID_INPUT', 'Photo size does not match its upload ticket.');
    }
    const bytes = prepareJpeg(input, c.req.header('Content-Type') ?? '');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    // A stream can outlive its capability. Recheck immediately before the first write.
    if (Date.now() >= Date.parse(reservation.expiresAt)) {
      throw new ApiError(410, 'EXPIRED', 'Upload ticket expired. Request a new ticket.', true);
    }
    let stored;
    try {
      stored = await c.env.PHOTOS.put(reservation.objectKey, bytes, {
        onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'image/jpeg' },
        customMetadata: { photoId: reservation.photoId, sha256, expiresAt: reservation.expiresAt },
      });
    } catch {
      throw new ApiError(503, 'UNAVAILABLE', 'Photo storage is temporarily unavailable.', true);
    }
    if (!stored) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This photo ID has already been used.');
    await finalizeReportPhoto(database, {
      ...reservation, byteSize: bytes.byteLength, sha256, ordinal: reservation.request.ordinal,
      purpose: reservation.request.purpose,
    }, uploadLimit);
    return c.json(UploadResultSchema.parse({ photoId: reservation.photoId, state: 'UPLOADED' }), 201);
  });
  return routes;
}
