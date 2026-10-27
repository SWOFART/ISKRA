import { decode } from 'jpeg-js';
import { POLICY } from '../../shared/contracts';
import { ApiError } from '../middleware/errors';

// Check T.81 marker framing: the pixel decoder permits absent scans and ignores trailing data.
function assertJpegStructure(bytes: Uint8Array): void {
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
      return;
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
    assertJpegStructure(bytes);
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
