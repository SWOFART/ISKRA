import {
  POLICY,
  type ErrorCode,
  type Location,
  type Point,
} from '../shared/contracts';

export type LocationCaptureFailure =
  | 'unsupported'
  | 'permission'
  | 'timeout'
  | 'unavailable'
  | 'inaccurate'
  | 'stale'
  | 'tooFar';

export class LocationCaptureError extends Error {
  constructor(readonly reason: LocationCaptureFailure) {
    super(`Location capture failed: ${reason}`);
    this.name = 'LocationCaptureError';
  }
}

export interface LocationCaptureRuntime {
  geolocation?: Pick<Geolocation, 'getCurrentPosition'> | null;
  now?: () => number;
}

export interface ReportLocationBinding {
  readonly purpose: 'report';
  readonly location: Location;
  readonly pin: Point;
  readonly boundAt: number;
}

export interface CleanupLocationBinding {
  readonly purpose: 'cleanup';
  readonly location: Location;
  readonly reportPin: Point;
  readonly distanceM: number;
  readonly boundAt: number;
}

export interface VoteLocationBinding {
  readonly purpose: 'vote';
  readonly location: Location;
  readonly reportPin: Point;
  readonly distanceM: number;
  readonly boundAt: number;
}

export type AnalysisLocationBinding = ReportLocationBinding | CleanupLocationBinding;

const earthRadiusM = 6_371_000;
const freshPositionOptions: PositionOptions = Object.freeze({
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 15_000,
});

function pointOf(location: Pick<Location, 'lat' | 'lng'>): Point {
  return { lat: location.lat, lng: location.lng };
}

function validatePoint(point: Point): void {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90
    || !Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
    throw new LocationCaptureError('unavailable');
  }
}

function copyLocation(location: Location): Location {
  return Object.freeze({
    lat: location.lat,
    lng: location.lng,
    accuracyM: location.accuracyM,
    observedAt: location.observedAt,
  });
}

function copyPoint(point: Point): Point {
  return Object.freeze({ lat: point.lat, lng: point.lng });
}

function validateFresh(location: Location, now: number): void {
  const observedAt = typeof location.observedAt === 'string' ? Date.parse(location.observedAt) : Number.NaN;
  if (!Number.isFinite(location.lat) || location.lat < -90 || location.lat > 90
    || !Number.isFinite(location.lng) || location.lng < -180 || location.lng > 180
    || !Number.isFinite(location.accuracyM) || location.accuracyM < 0) {
    throw new LocationCaptureError('unavailable');
  }
  if (location.accuracyM > POLICY.maxAccuracyM) throw new LocationCaptureError('inaccurate');
  if (!Number.isFinite(now) || !Number.isFinite(observedAt)
    || new Date(observedAt).toISOString() !== location.observedAt || observedAt > now
    || now - observedAt > POLICY.maxLocationAgeSeconds * 1000) {
    throw new LocationCaptureError('stale');
  }
}

function convertPosition(position: GeolocationPosition): Location {
  const { latitude, longitude, accuracy } = position.coords;
  const observedAt = position.timestamp;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy)
    || !Number.isFinite(observedAt)) throw new LocationCaptureError('unavailable');
  const observedAtDate = new Date(observedAt);
  if (!Number.isFinite(observedAtDate.getTime())) throw new LocationCaptureError('unavailable');
  return {
    lat: latitude,
    lng: longitude,
    accuracyM: accuracy,
    observedAt: observedAtDate.toISOString(),
  };
}

function geolocationFailure(error: GeolocationPositionError): LocationCaptureFailure {
  if (error.code === 1) return 'permission';
  if (error.code === 3) return 'timeout';
  return 'unavailable';
}

/** Request a one-shot fix without allowing the browser to return a cached position. */
export async function acquireFreshLocation(runtime: LocationCaptureRuntime = {}): Promise<Location> {
  const geolocation = runtime.geolocation === undefined
    ? (typeof navigator === 'undefined' ? undefined : navigator.geolocation)
    : runtime.geolocation;
  if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
    throw new LocationCaptureError('unsupported');
  }

  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    geolocation.getCurrentPosition(resolve, (error) => reject(new LocationCaptureError(geolocationFailure(error))), {
      ...freshPositionOptions,
    });
  });
  const location = convertPosition(position);
  validateFresh(location, (runtime.now ?? Date.now)());
  return location;
}

/** Great-circle distance in meters between two WGS84 coordinates. */
export function distanceMeters(a: Point, b: Point): number {
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)
    || a.lat < -90 || a.lat > 90 || b.lat < -90 || b.lat > 90
    || a.lng < -180 || a.lng > 180 || b.lng < -180 || b.lng > 180) return Number.POSITIVE_INFINITY;
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = lat2 - lat1;
  const deltaLng = toRadians(b.lng - a.lng);
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

/** Keep a proposed report pin within the selected 3m displacement limit. */
export function clampPinToMeasuredFix(measured: Point, requested: Point): Point {
  validatePoint(measured);
  validatePoint(requested);
  const distance = distanceMeters(measured, requested);
  if (distance <= POLICY.maxPinDisplacementM) return copyPoint(requested);
  if (distance === 0) return copyPoint(measured);

  const lat1 = measured.lat * Math.PI / 180;
  const lng1 = measured.lng * Math.PI / 180;
  const lat2 = requested.lat * Math.PI / 180;
  const lng2 = requested.lng * Math.PI / 180;
  const deltaLng = lng2 - lng1;
  const bearing = Math.atan2(
    Math.sin(deltaLng) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng),
  );
  const angularDistance = (POLICY.maxPinDisplacementM - 0.001) / earthRadiusM;
  const lat = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
      + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lng = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat),
  );
  const wrappedLng = ((lng * 180 / Math.PI + 540) % 360) - 180;
  return copyPoint({ lat: lat * 180 / Math.PI, lng: wrappedLng });
}

export function bindReportLocation(
  location: Location,
  requestedPin: Point = pointOf(location),
  now = Date.now(),
): ReportLocationBinding {
  validateFresh(location, now);
  validatePoint(requestedPin);
  const pin = clampPinToMeasuredFix(pointOf(location), requestedPin);
  return Object.freeze({ purpose: 'report', location: copyLocation(location), pin, boundAt: now });
}

function bindProximityLocation<T extends 'cleanup' | 'vote'>(
  purpose: T,
  location: Location,
  reportPin: Point,
  now: number,
): T extends 'cleanup' ? CleanupLocationBinding : VoteLocationBinding {
  validateFresh(location, now);
  validatePoint(reportPin);
  const distanceM = distanceMeters(pointOf(location), reportPin);
  const radius = purpose === 'cleanup' ? POLICY.cleanupRadiusM : POLICY.voteRadiusM;
  // A one-micrometer allowance absorbs floating-point error at the inclusive boundary.
  if (distanceM - radius > 0.000001) throw new LocationCaptureError('tooFar');
  const binding = Object.freeze({
    purpose,
    location: copyLocation(location),
    reportPin: copyPoint(reportPin),
    distanceM,
    boundAt: now,
  });
  return binding as unknown as T extends 'cleanup' ? CleanupLocationBinding : VoteLocationBinding;
}

export function bindCleanupLocation(location: Location, reportPin: Point, now = Date.now()): CleanupLocationBinding {
  return bindProximityLocation('cleanup', location, reportPin, now);
}

export function bindVoteLocation(location: Location, reportPin: Point, now = Date.now()): VoteLocationBinding {
  return bindProximityLocation('vote', location, reportPin, now);
}

export async function captureFreshReportLocation(runtime: LocationCaptureRuntime = {}): Promise<ReportLocationBinding> {
  const location = await acquireFreshLocation(runtime);
  return bindReportLocation(location, undefined, (runtime.now ?? Date.now)());
}

export async function captureFreshCleanupLocation(
  reportPin: Point,
  runtime: LocationCaptureRuntime = {},
): Promise<CleanupLocationBinding> {
  const location = await acquireFreshLocation(runtime);
  return bindCleanupLocation(location, reportPin, (runtime.now ?? Date.now)());
}

export async function captureFreshVoteLocation(
  reportPin: Point,
  runtime: LocationCaptureRuntime = {},
): Promise<VoteLocationBinding> {
  const location = await acquireFreshLocation(runtime);
  return bindVoteLocation(location, reportPin, (runtime.now ?? Date.now)());
}

const locationRecoveryCodes = new Set<ErrorCode>([
  'TOO_FAR', 'LOCATION_INACCURATE', 'LOCATION_STALE', 'PIN_TOO_FAR',
]);

/** Location errors are recovered by acquiring a new fix; callers must never resend the rejected one. */
export function isLocationRecoveryError(code: ErrorCode): boolean {
  return locationRecoveryCodes.has(code);
}

export async function acquireFreshLocationAfterServerError(
  code: ErrorCode,
  runtime: LocationCaptureRuntime = {},
): Promise<Location> {
  if (!isLocationRecoveryError(code)) throw new TypeError(`Server error ${code} does not request a fresh location`);
  return acquireFreshLocation(runtime);
}
