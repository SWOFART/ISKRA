import { encode } from 'jpeg-js';
import { readFileSync } from 'node:fs';
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
      valid.slice(0, -10), new Uint8Array([...valid, 1, 2]),
      new Uint8Array([...valid, 0, 17, 255, 217]), new Uint8Array([...valid, ...valid])]) {
      expect(() => validateJpeg(bytes, 'image/jpeg')).toThrow();
    }
  });

  it('rejects a frame with no scan, an empty scan and truncated entropy before EOI', () => {
    const valid = photo();
    const sos = valid.findIndex((value, index) => value === 0xff && valid[index + 1] === 0xda);
    const scanStart = sos + 2 + ((valid[sos + 2] << 8) | valid[sos + 3]);
    expect(sos).toBeGreaterThan(0);
    for (const end of [sos, scanStart, scanStart + 1]) {
      expect(() => validateJpeg(new Uint8Array([...valid.slice(0, end), 255, 217]), 'image/jpeg')).toThrow();
    }
  });

  it('rejects invalid segment lengths and scan selectors', () => {
    const valid = photo();
    const sos = valid.findIndex((value, index) => value === 0xff && valid[index + 1] === 0xda);
    for (const [at, value] of [[5, 1], [sos + 4, 0], [sos + 5, 99]]) {
      const bytes = valid.slice(); bytes[at] = value;
      expect(() => validateJpeg(bytes, 'image/jpeg')).toThrow();
    }
  });

  it('rejects a scan that omits frame components', () => {
    const valid = photo();
    const sos = valid.findIndex((value, index) => value === 0xff && valid[index + 1] === 0xda);
    const scanStart = sos + 2 + ((valid[sos + 2] << 8) | valid[sos + 3]);
    const oneComponentScan = [255, 218, 0, 8, 1, valid[sos + 5], valid[sos + 6], 0, 63, 0];
    const bytes = new Uint8Array([...valid.slice(0, sos), ...oneComponentScan, ...valid.slice(scanStart)]);
    expect(() => validateJpeg(bytes, 'image/jpeg')).toThrow();
  });

  it.each(['progressive', 'grayscale', 'restart'])('accepts a synthetic %s JPEG', (kind) => {
    const bytes = readFileSync(new URL(`../../fixtures/photos/${kind}.jpg`, import.meta.url));
    expect(validateJpeg(bytes, 'image/jpeg')).toEqual(kind === 'restart'
      ? { width: 16, height: 16 } : { width: 2, height: 3 });
  });

  it('rejects a scan truncated before its required restart intervals', () => {
    const bytes = readFileSync(new URL('../../fixtures/photos/restart.jpg', import.meta.url));
    const firstRestart = bytes.findIndex((value, index) => value === 0xff && bytes[index + 1] === 0xd0);
    expect(firstRestart).toBeGreaterThan(0);
    expect(() => validateJpeg(new Uint8Array([...bytes.slice(0, firstRestart), 255, 217]), 'image/jpeg')).toThrow();
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
