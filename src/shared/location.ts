import { LocationSchema, PointSchema, POLICY, type ErrorCode, type Location, type Point } from './contracts';

/** Measured great-circle distance; does not claim to detect fabricated browser GPS. */
export function distanceM(a: Point, b: Point): number {
  PointSchema.parse({ lat: a.lat, lng: a.lng }); PointSchema.parse({ lat: b.lat, lng: b.lng });
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** Only call for NEW action admission. Accepted replays and valid analysis consumption skip freshness. */
export function locationAdmission(
  input: Location, now: number, target?: Point, radiusM: number = POLICY.voteRadiusM,
): ErrorCode | null {
  if (!Number.isFinite(now) || !Number.isFinite(radiusM) || radiusM < 0) throw new TypeError('Invalid admission clock/radius');
  if (typeof input?.accuracyM === 'number' && Number.isFinite(input.accuracyM)
    && input.accuracyM > POLICY.maxAccuracyM) return 'LOCATION_INACCURATE';
  const location = LocationSchema.parse(input);
  const age = now - Date.parse(location.observedAt);
  if (age < 0 || age > POLICY.maxLocationAgeSeconds * 1000) return 'LOCATION_STALE';
  if (target && distanceM(location, target) > radiusM) return 'TOO_FAR';
  return null;
}

export function reportPinAdmission(location: Location, pin: Point, now: number): ErrorCode | null {
  return locationAdmission(location, now) ?? (distanceM(location, pin) > POLICY.maxPinDisplacementM ? 'PIN_TOO_FAR' : null);
}
