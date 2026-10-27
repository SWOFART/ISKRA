import { decode } from 'jpeg-js';
import { POLICY } from '../../shared/contracts';
import { ApiError } from '../middleware/errors';

// shortcut: validation only; add authenticated upload/finalization after contracts freeze.
export function validateJpeg(bytes: Uint8Array, contentType: string): { width: number; height: number } {
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
    image = decode(bytes, {
      useTArray: true, formatAsRGBA: false, tolerantDecoding: false,
      maxResolutionInMP: 2.56, maxMemoryUsageInMB: 64,
    });
  } catch {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'The JPEG photo is invalid or exceeds image limits.');
  }
  if (image.width > 1600 || image.height > 1600) {
    throw new ApiError(413, 'PHOTO_TOO_LARGE', 'Resize the photo to at most 1600 pixels per side.');
  }
  return { width: image.width, height: image.height };
}
