import { describe, expect, it, vi } from 'vitest';
import type { Location, Point } from '../../../src/shared/contracts';
import {
  acquireFreshLocation,
  acquireFreshLocationAfterServerError,
  bindCleanupLocation,
  bindReportLocation,
  bindVoteLocation,
  clampPinToMeasuredFix,
  captureFreshCleanupLocation,
  captureFreshReportLocation,
  distanceMeters,
  isLocationRecoveryError,
  LocationCaptureError,
  type LocationCaptureRuntime,
} from '../../../src/client/locationCapture';

const now = Date.parse('2026-10-28T10:00:00.000Z');

function geoPosition(overrides: Partial<{
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}> = {}): GeolocationPosition {
  const { lat = 49.14, lng = 9.22, accuracy = 12, timestamp = now } = overrides;
  return {
    coords: { latitude: lat, longitude: lng, accuracy, altitude: null, altitudeAccuracy: null,
      heading: null, speed: null, toJSON: () => ({}) },
    timestamp,
    toJSON: () => ({}),
  } as GeolocationPosition;
}

function location(overrides: Partial<Location> = {}): Location {
  return {
    lat: 49.14,
    lng: 9.22,
    accuracyM: 12,
    observedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

function runtimeFor(
  positions: GeolocationPosition[],
  onError?: (error: PositionErrorCallback) => void,
): LocationCaptureRuntime & { options: PositionOptions[]; getCurrentPosition: ReturnType<typeof vi.fn> } {
  const options: PositionOptions[] = [];
  const getCurrentPosition = vi.fn((success: PositionCallback, error: PositionErrorCallback, requestOptions?: PositionOptions) => {
    if (requestOptions) options.push(requestOptions);
    if (onError) {
      onError(error);
      return;
    }
    const position = positions.shift();
    if (!position) throw new Error('No geolocation fixture remains.');
    success(position);
  });
  return { geolocation: { getCurrentPosition }, now: () => now, options, getCurrentPosition };
}

function eastAtMeters(origin: Point, meters: number): Point {
  return { lat: origin.lat, lng: origin.lng + meters / 6_371_000 * 180 / Math.PI / Math.cos(origin.lat * Math.PI / 180) };
}

describe('fresh GPS capture and proximity validation', () => {
  it('requests independent fresh report and cleanup fixes without reusing the report location', async () => {
    const runtime = runtimeFor([geoPosition(), geoPosition({ lat: 49.1401 })]);
    const report = await captureFreshReportLocation(runtime);
    const cleanup = await captureFreshCleanupLocation({ lat: 49.14, lng: 9.22 }, runtime);

    expect(report.location.lat).toBe(49.14);
    expect(cleanup.location.lat).toBe(49.1401);
    expect(cleanup.location).not.toEqual(report.location);
    expect(runtime.getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(runtime.options).toEqual([
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    ]);
  });

  it.each([
    ['inaccurate', geoPosition({ accuracy: 50.01 })],
    ['stale', geoPosition({ timestamp: now - 60_001 })],
    ['stale', geoPosition({ timestamp: now + 1 })],
    ['unavailable', geoPosition({ lat: Number.NaN })],
  ] as const)('rejects %s browser fixes', async (reason, position) => {
    await expect(acquireFreshLocation(runtimeFor([position]))).rejects.toMatchObject({
      name: 'LocationCaptureError', reason,
    });
  });

  it('accepts the inclusive accuracy and freshness limits', async () => {
    await expect(acquireFreshLocation(runtimeFor([
      geoPosition({ accuracy: 50, timestamp: now - 60_000 }),
    ]))).resolves.toMatchObject({ accuracyM: 50, observedAt: new Date(now - 60_000).toISOString() });
  });

  it('maps permission denial and unsupported geolocation to recoverable UI reasons', async () => {
    const denied = runtimeFor([], (error) => error({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    await expect(acquireFreshLocation(denied)).rejects.toMatchObject({ reason: 'permission' });
    await expect(acquireFreshLocation({ geolocation: null })).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('clamps the report pin to three meters and keeps the default pin at the measured fix', () => {
    const fix = location();
    const measured = { lat: fix.lat, lng: fix.lng };
    const requested = eastAtMeters(measured, 20);
    const binding = bindReportLocation(fix, requested, now);
    expect(distanceMeters(measured, binding.pin)).toBeLessThanOrEqual(3);
    expect(distanceMeters(measured, bindReportLocation(fix, undefined, now).pin)).toBe(0);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.location)).toBe(true);
  });

  it('accepts cleanup and vote at 150m but rejects a fix beyond the measured radius', () => {
    const reportPin = { lat: 0, lng: 0 };
    const atBoundary = location({ lat: 0, lng: 150 / 6_371_000 * 180 / Math.PI });
    expect(distanceMeters({ lat: atBoundary.lat, lng: atBoundary.lng }, reportPin)).toBeCloseTo(150, 5);
    expect(bindCleanupLocation(atBoundary, reportPin, now).distanceM).toBeCloseTo(150, 5);
    expect(bindVoteLocation(atBoundary, reportPin, now).distanceM).toBeCloseTo(150, 5);
    const outside = location({ lat: 0, lng: 150.1 / 6_371_000 * 180 / Math.PI });
    expect(() => bindCleanupLocation(outside, reportPin, now)).toThrowError(LocationCaptureError);
    expect(() => bindVoteLocation(outside, reportPin, now)).toThrowError(LocationCaptureError);
  });

  it('keeps an admitted immutable fix bound during a multi-minute preview', () => {
    const fix = location({ observedAt: new Date(now - 5_000).toISOString() });
    const binding = bindReportLocation(fix, undefined, now);
    const severalMinutesLater = now + 5 * 60_000;

    expect(() => bindReportLocation(fix, undefined, severalMinutesLater)).toThrowError(LocationCaptureError);
    expect(binding.location).toEqual(fix);
    expect(binding.boundAt).toBe(now);
  });

  it('forces a new acquisition after a recoverable server location error', async () => {
    const runtime = runtimeFor([geoPosition({ lng: 9.2201 })]);
    expect(isLocationRecoveryError('LOCATION_STALE')).toBe(true);
    expect(isLocationRecoveryError('AI_UNAVAILABLE')).toBe(false);
    await expect(acquireFreshLocationAfterServerError('LOCATION_STALE', runtime))
      .resolves.toMatchObject({ lng: 9.2201 });
    expect(runtime.getCurrentPosition).toHaveBeenCalledTimes(1);
    await expect(acquireFreshLocationAfterServerError('AI_UNAVAILABLE', runtime)).rejects.toThrow(TypeError);
    expect(runtime.getCurrentPosition).toHaveBeenCalledTimes(1);
  });
});
