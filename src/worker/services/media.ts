import { errors, jwtVerify, SignJWT } from 'jose';
import { PhotoSchema, UidSchema, UuidSchema } from '../../shared/contracts';
import { literal, object, union } from '../../shared/schema';
import type { AttachedPhotoReference, ReportMediaResolver } from './report-context';
import type { TransactionDatabase } from '../db/client';
import { readPhoto } from '../db/evidence-store';
import { decode, encode } from 'jpeg-js';
import { POLICY } from '../../shared/contracts';
import { ApiError } from '../middleware/errors';

// Check T.81 marker framing: the pixel decoder permits absent scans and ignores trailing data.
function inspectJpeg(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  let frame: { width: number; height: number; progressive: boolean; components: Map<number, { h: number; v: number }> } | undefined;
  const scanned = new Set<number>();
  let restartInterval = 0;
  const invalid = () => { throw new Error('Invalid JPEG structure'); };
  const word = (at: number) => (bytes[at] << 8) | bytes[at + 1];

  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || offset !== bytes.length || scanned.size !== frame.components.size) return invalid();
      return { width: frame.width, height: frame.height };
    }
    if (marker === 0 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
      || offset + 2 > bytes.length) invalid();
    const length = word(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalid();

    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || length < 11 || length !== 8 + 3 * bytes[offset + 7]) invalid();
      const components = new Map<number, { h: number; v: number }>();
      for (let at = offset + 8; at < end; at += 3) {
        const h = bytes[at + 1] >> 4;
        const v = bytes[at + 1] & 15;
        if (components.has(bytes[at]) || h < 1 || h > 4 || v < 1 || v > 4) invalid();
        components.set(bytes[at], { h, v });
      }
      frame = { width: word(offset + 5), height: word(offset + 3), progressive: marker === 0xc2, components };
      if (!frame.width || !frame.height) invalid();
    } else if (marker === 0xdd) {
      if (length !== 4) invalid();
      restartInterval = word(offset + 2);
    } else if (marker === 0xda) {
      if (!frame || length < 8) return invalid();
      const count = bytes[offset + 2];
      if (!count || length !== 6 + 2 * count) invalid();
      const selectors = new Set<number>();
      for (let at = offset + 3; at < end - 3; at += 2) {
        if (!frame.components.has(bytes[at]) || selectors.has(bytes[at])) invalid();
        selectors.add(bytes[at]);
      }
      const spectralStart = bytes[end - 3];
      const spectralEnd = bytes[end - 2];
      const approximation = bytes[end - 1];
      if ((!frame.progressive && (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0))
        || (frame.progressive && (spectralStart > spectralEnd || spectralEnd > 63
          || (spectralStart === 0 ? spectralEnd !== 0 : count !== 1)))) invalid();
      if (spectralStart === 0 && (approximation >> 4) === 0) selectors.forEach((id) => scanned.add(id));

      const maxH = Math.max(...[...frame.components.values()].map((c) => c.h));
      const maxV = Math.max(...[...frame.components.values()].map((c) => c.v));
      const component = frame.components.get([...selectors][0])!;
      const units = count === 1
        ? Math.ceil(Math.ceil(frame.width / 8) * component.h / maxH) * Math.ceil(Math.ceil(frame.height / 8) * component.v / maxV)
        : Math.ceil(frame.width / (8 * maxH)) * Math.ceil(frame.height / (8 * maxV));
      let restarts = 0;
      let entropyBytes = 0;
      offset = end;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { entropyBytes++; offset++; continue; }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        if (bytes[next] === 0) {
          if (next !== offset + 1) invalid();
          entropyBytes++; offset = next + 1;
        } else if (bytes[next] >= 0xd0 && bytes[next] <= 0xd7) {
          if (!entropyBytes || bytes[next] !== 0xd0 + (restarts % 8)) invalid();
          restarts++; entropyBytes = 0; offset = next + 1;
        } else break;
      }
      if (!entropyBytes || restarts !== (restartInterval ? Math.floor((units - 1) / restartInterval) : 0)) invalid();
      continue;
    }
    offset = end;
  }
  return invalid();
}

function decodeJpeg(bytes: Uint8Array, contentType: string) {
  if (bytes.byteLength > POLICY.maxPhotoBytes) {
    throw new ApiError(413, 'PHOTO_TOO_LARGE', 'Photos must be at most 1 MiB.');
  }
  if (contentType !== 'image/jpeg' || bytes.length < 4
    || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Provide a valid JPEG photo.');
  }
  let image;
  try {
    const dimensions = inspectJpeg(bytes);
    if (dimensions.width > 1600 || dimensions.height > 1600) {
      throw new ApiError(413, 'PHOTO_TOO_LARGE', 'Resize the photo to at most 1600 pixels per side.');
    }
    image = decode(bytes, {
      useTArray: true, formatAsRGBA: true, tolerantDecoding: false,
      maxResolutionInMP: 2.56, maxMemoryUsageInMB: 64,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'The JPEG photo is invalid or exceeds image limits.');
  }
  return image;
}

export function validateJpeg(bytes: Uint8Array, contentType: string): { width: number; height: number } {
  const { width, height } = decodeJpeg(bytes, contentType);
  return { width, height };
}

/** Encode pixels only; never carry EXIF, thumbnails or source comments into storage. */
export function prepareJpeg(bytes: Uint8Array, contentType: string): Uint8Array<ArrayBuffer> {
  const { width, height, data } = decodeJpeg(bytes, contentType);
  const encoded = new Uint8Array(encode({ width, height, data }, 80).data);
  if (encoded.byteLength > POLICY.maxPhotoBytes) {
    throw new ApiError(413, 'PHOTO_TOO_LARGE', 'The re-encoded photo exceeds 1 MiB. Resize and retry.');
  }
  return encoded;
}

const READ_SECONDS = 300;
const READ_ISSUER = 'iskra:photo';
const READ_TYPE = 'iskra-photo+jwt';
const publicAccess = object({ scope: literal('PUBLIC'), photoId: UuidSchema });
const ownerAccess = object({ scope: literal('OWNER'), photoId: UuidSchema, uid: UidSchema });
const readAccess = union(publicAccess, ownerAccess);

function photoSigningKey(secret: string | undefined) {
  const key = new TextEncoder().encode(secret);
  if (!secret || key.byteLength < 32) {
    throw new ApiError(503, 'UNAVAILABLE', 'Photo access is not configured.');
  }
  return key;
}

function photoOrigin(origin: string) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) {
    throw new ApiError(503, 'UNAVAILABLE', 'Photo access requires an HTTPS application origin.');
  }
  return origin;
}

/** Owner scope is for authenticated preview callers; public scope is for B's attached-photo projection only. */
export async function createPhotoReadCapability(
  reference: AttachedPhotoReference,
  origin: string,
  secret: string | undefined,
  ownerUid?: string,
) {
  const key = photoSigningKey(secret);
  const audience = photoOrigin(origin);
  const access = readAccess.parse(ownerUid === undefined
    ? { scope: 'PUBLIC', photoId: reference.id }
    : { scope: 'OWNER', photoId: reference.id, uid: ownerUid });
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ access })
    .setProtectedHeader({ alg: 'HS256', typ: READ_TYPE }).setIssuer(READ_ISSUER)
    .setAudience(audience).setIssuedAt(issuedAt).setExpirationTime(issuedAt + READ_SECONDS).sign(key);
  return PhotoSchema.parse({
    id: reference.id, ordinal: reference.ordinal,
    mediaUrl: `${audience}/api/photos/${reference.id}/content?token=${encodeURIComponent(token)}`,
    expiresAt: new Date((issuedAt + READ_SECONDS) * 1000).toISOString(),
  });
}

export function createReportMediaResolver(origin: string, secret: string | undefined): ReportMediaResolver {
  return {
    resolveAttachedPhotos: (photos) => Promise.all(photos.map((photo) =>
      createPhotoReadCapability(photo, origin, secret))),
  };
}

export async function authorizePhotoRead(
  database: TransactionDatabase,
  photoId: string,
  token: string | undefined,
  origin: string,
  secret: string | undefined,
  uid?: string,
) {
  const key = photoSigningKey(secret);
  if (!token || token.length > 4096 || !UuidSchema.safeParse(photoId).success) {
    throw new ApiError(403, 'FORBIDDEN', 'Invalid photo access.');
  }
  let access;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'], issuer: READ_ISSUER, audience: photoOrigin(origin), typ: READ_TYPE,
      requiredClaims: ['iat', 'exp'],
    });
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.iat! > Math.floor(Date.now() / 1000) || payload.exp! - payload.iat! !== READ_SECONDS) {
      throw new Error('Invalid photo capability lifetime');
    }
    access = readAccess.parse(payload.access);
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new ApiError(410, 'EXPIRED', 'Photo link expired. Refresh the report to try again.');
    }
    throw new ApiError(403, 'FORBIDDEN', 'Invalid photo access.');
  }
  if (access.photoId.toLowerCase() !== photoId.toLowerCase()
    || (access.scope === 'OWNER' && access.uid !== uid)) {
    throw new ApiError(403, 'FORBIDDEN', 'Invalid photo access.');
  }
  const photo = await readPhoto(database, photoId);
  if (!photo || photo.state === 'RESERVED') throw new ApiError(404, 'NOT_FOUND', 'Photo not found.');
  if (access.scope === 'PUBLIC' ? !photo.published : photo.owner_user_id !== uid) {
    throw new ApiError(403, 'FORBIDDEN', 'Photo access is not allowed.');
  }
  return photo;
}
