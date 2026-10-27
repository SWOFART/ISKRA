import { encode } from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { validateJpeg } from '../../../src/worker/services/media';

function photo(width = 2, height = 2) {
  return new Uint8Array(encode({ width, height, data: new Uint8Array(width * height * 4).fill(255) }, 80).data);
}

describe('standalone bounded JPEG validation', () => {
  it('fully decodes an actual JPEG and returns dimensions', () => {
    expect(validateJpeg(photo(2, 3), 'image/jpeg')).toEqual({ width: 2, height: 3 });
  });

  it.each(['image/png', 'application/octet-stream', ''])('rejects unsupported MIME %s', (type) => {
    expect(() => validateJpeg(photo(), type)).toThrow('valid JPEG');
  });

  it('rejects MIME forgery, marker-only data, truncation and trailing content', () => {
    const valid = photo();
    for (const bytes of [new TextEncoder().encode('not a JPEG'), new Uint8Array([255, 216, 255, 217]),
      valid.slice(0, -10), new Uint8Array([...valid, 1, 2])]) {
      expect(() => validateJpeg(bytes, 'image/jpeg')).toThrow();
    }
  });

  it('enforces the byte cap before decoding', () => {
    expect(() => validateJpeg(new Uint8Array(1_048_577), 'image/jpeg')).toThrow('at most 1 MiB');
  });

  it('accepts a 1600px side and rejects larger dimensions', () => {
    expect(validateJpeg(photo(1600, 1), 'image/jpeg')).toEqual({ width: 1600, height: 1 });
    expect(() => validateJpeg(photo(1601, 1), 'image/jpeg')).toThrow('1600 pixels');
  });

  it('accepts the full selected 1600 by 1600 resolution', () => {
    expect(validateJpeg(photo(1600, 1600), 'image/jpeg')).toEqual({ width: 1600, height: 1600 });
  });

  it('rejects a forged decompression-bomb frame with a safe error', () => {
    const bytes = photo();
    const frame = bytes.findIndex((value, index) => value === 0xff && bytes[index + 1] === 0xc0);
    expect(frame).toBeGreaterThan(0);
    bytes.fill(0xff, frame + 5, frame + 9);
    expect(() => validateJpeg(bytes, 'image/jpeg')).toThrow('invalid or exceeds image limits');
  });
});
