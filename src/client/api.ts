import {
  API_ERROR_POLICY,
  ErrorEnvelopeSchema,
  PublishRequestSchema,
  PublicReportDetailSchema,
  ReportListSchema,
  UploadResultSchema,
  UploadTicketSchema,
  ReportSummarySchema,
  UuidSchema,
  type ErrorCode,
} from '../shared/contracts';
import type { Infer, Schema } from '../shared/schema';
import type { OperationKeyScope } from './operationKey';

export const DEVELOPMENT_FIXTURE_LABEL = 'DEVELOPMENT FIXTURE — NOT LIVE DATA';

export type ApiMode = 'live' | 'fixture';
export type ApiAuth = 'none' | 'optional' | 'required';
export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface FirebaseTokenProvider {
  getIdToken(forceRefresh: boolean): Promise<string | null>;
}

export interface ApiProvenance {
  mode: ApiMode;
  label: string;
}

export interface ApiResult<T> {
  data: T;
  provenance: ApiProvenance;
  status: number;
}

export interface ApiClientErrorOptions {
  code: ErrorCode | 'INVALID_RESPONSE';
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ApiClientError extends Error {
  readonly code: ErrorCode | 'INVALID_RESPONSE';
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(options: ApiClientErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'ApiClientError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface FixtureRequest {
  method: ApiMethod;
  path: string;
  body?: unknown;
}

export interface FixtureResponse {
  status: number;
  body: unknown;
  headers?: HeadersInit;
}

export type FixtureResolver = (request: FixtureRequest) => Promise<FixtureResponse> | FixtureResponse;

export interface ApiRequest<T> {
  path: string;
  responseSchema: Schema<T>;
  method?: ApiMethod;
  auth?: ApiAuth;
  body?: unknown;
  bodySchema?: Schema<unknown>;
  rawBody?: Blob;
  operation?: OperationKeyScope;
  requiresOperationKey?: boolean;
  acceptedStatuses?: readonly number[];
  signal?: AbortSignal;
}

export interface CreateClientApiOptions {
  mode: ApiMode;
  tokenProvider?: FirebaseTokenProvider;
  fetcher?: typeof fetch;
  fixtureResolver?: FixtureResolver;
  apiBasePath?: string;
}

const liveProvenance: ApiProvenance = Object.freeze({ mode: 'live', label: 'Live API data' });
const fixtureProvenance: ApiProvenance = Object.freeze({ mode: 'fixture', label: DEVELOPMENT_FIXTURE_LABEL });

function safePath(path: string): string {
  const rawPathname = path.split(/[?#]/, 1)[0];
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    throw new TypeError('API paths must be absolute paths on the configured API origin.');
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')
    || pathname.includes('\\')
    || pathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError('API paths must be absolute paths on the configured API origin.');
  }
  return path;
}

function routePath(path: string): string {
  return decodeURIComponent(path.split(/[?#]/, 1)[0]);
}

function defaultAuth(method: ApiMethod, path: string): ApiAuth {
  const pathname = routePath(path);
  if (method === 'GET' && pathname === '/health') return 'none';
  if (method === 'GET' && (pathname === '/reports' || /^\/reports\/[0-9a-f-]{36}$/i.test(pathname))) {
    return 'optional';
  }
  if (method === 'GET' && /^\/photos\/[0-9a-f-]{36}\/content$/i.test(pathname)
    && new URL(path, 'https://iskra.invalid').searchParams.has('token')) {
    return 'none';
  }
  return 'required';
}

function requiresIdempotencyKey(method: ApiMethod, path: string): boolean {
  const pathname = routePath(path);
  return method === 'POST' && (
    pathname === '/reports'
    || pathname === '/ai/analyze-report'
    || pathname === '/ai/analyze-cleanup'
    || /^\/reports\/[0-9a-f-]{36}\/(?:votes|cleanups)$/i.test(pathname)
  );
}

function safeBasePath(path: string): string {
  const normalized = path.replace(/\/$/, '');
  if (!normalized.startsWith('/') || normalized.startsWith('//') || normalized.includes('\\')
    || normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError('The API base path must be a same-origin absolute path.');
  }
  return normalized;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function invalidResponse(status?: number, cause?: unknown): ApiClientError {
  return new ApiClientError({
    code: 'INVALID_RESPONSE',
    message: 'The service returned a response that could not be verified.',
    retryable: false,
    status,
    cause,
  });
}

function errorFromPayload(status: number, payload: unknown, retryAfter: string | null): ApiClientError {
  const parsed = ErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return invalidResponse(status, parsed.error);

  const { error } = parsed.data;
  if (API_ERROR_POLICY[error.code].httpStatus !== status) {
    return invalidResponse(status);
  }

  return new ApiClientError({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    status,
    requestId: error.requestId,
    retryAfterMs: parseRetryAfter(retryAfter),
  });
}

async function errorFromResponse(response: Response): Promise<ApiClientError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    return invalidResponse(response.status, cause);
  }

  return errorFromPayload(response.status, payload, response.headers.get('Retry-After'));
}

function isAcceptedStatus(status: number, acceptedStatuses?: readonly number[]): boolean {
  return acceptedStatuses
    ? acceptedStatuses.includes(status)
    : status >= 200 && status < 300;
}

async function parseP0Fixture(request: FixtureRequest): Promise<FixtureResponse> {
  if (!import.meta.env.DEV) {
    throw new ApiClientError({
      code: 'UNAVAILABLE',
      message: 'Development fixtures are unavailable in this build.',
      retryable: false,
    });
  }

  const { default: fixtures } = await import('../../tests/fixtures/contracts/p0.json');
  const path = new URL(request.path, 'https://iskra.invalid').pathname;
  const report = PublicReportDetailSchema.parse(fixtures.publicReport);
  const reportSummary = ReportSummarySchema.parse({
    id: report.id,
    route: report.route,
    status: report.status,
    location: report.location,
    coverPhotoId: report.coverPhotoId,
    description: report.description,
    existenceYesCount: report.existenceYesCount,
    resolutionYesCount: report.resolutionYesCount,
    existenceVerifiedAt: report.existenceVerifiedAt,
    lastExistenceConfirmedAt: report.lastExistenceConfirmedAt,
    version: report.version,
    updatedAt: report.updatedAt,
    isDemo: report.isDemo,
  });

  if (request.method === 'GET' && path === '/reports') {
    return { status: 200, body: { items: [reportSummary], nextCursor: null } };
  }
  if (request.method === 'GET' && /^\/reports\/[0-9a-f-]+$/i.test(path)) {
    return { status: 200, body: report };
  }
  if (request.method === 'POST' && path === '/me/bootstrap') {
    return { status: 200, body: fixtures.bootstrap };
  }
  if (request.method === 'GET' && path === '/me/impact') {
    return { status: 200, body: fixtures.impact };
  }
  if (request.method === 'GET' && path === '/me/notifications') {
    return { status: 200, body: fixtures.notifications };
  }
  if (request.method === 'POST' && path === '/reports') {
    return { status: 201, body: fixtures.publication };
  }
  if (request.method === 'POST' && /^\/reports\/[0-9a-f-]+\/votes$/i.test(path)) {
    return { status: 200, body: fixtures.newVote };
  }
  if (request.method === 'POST' && /^\/reports\/[0-9a-f-]+\/cleanups$/i.test(path)) {
    return { status: 201, body: fixtures.cleanupPending };
  }
  if (request.method === 'POST' && path === '/uploads') {
    const photoId = crypto.randomUUID();
    return { status: 201, body: {
      ...fixtures.uploadTicket,
      photoId,
      uploadUrl: `https://iskra.invalid/api/uploads/${photoId}/content?ticket=synthetic`,
    } };
  }
  if (request.method === 'PUT' && /^\/uploads\/[0-9a-f-]+\/content$/i.test(path)) {
    const photoId = path.split('/')[2];
    return { status: 201, body: { ...fixtures.uploadResult, photoId } };
  }
  if (request.method === 'POST' && path === '/ai/analyze-report') {
    return { status: 200, body: fixtures.reportAccepted };
  }
  if (request.method === 'POST' && path === '/ai/analyze-cleanup') {
    return { status: 200, body: fixtures.cleanupAccepted };
  }
  if (request.method === 'GET' && /^\/ai\/analyses\/[0-9a-f-]+$/i.test(path)) {
    return { status: 200, body: fixtures.reportAccepted };
  }

  throw new ApiClientError({
    code: 'INVALID_RESPONSE',
    message: 'No development fixture is defined for this API request.',
    retryable: false,
  });
}

function parseSuccess<T>(
  status: number,
  body: unknown,
  schema: Schema<T>,
  provenance: ApiProvenance,
): ApiResult<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidResponse(status, parsed.error);
  return { data: parsed.data, provenance, status };
}

export function createClientApi(options: CreateClientApiOptions) {
  const mode = options.mode;
  const apiBasePath = safeBasePath(options.apiBasePath ?? '/api');
  if (mode === 'fixture' && import.meta.env.PROD) {
    throw new Error('Fixture transport is disabled in production builds.');
  }

  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const fixtureResolver = options.fixtureResolver ?? parseP0Fixture;
  const provenance = mode === 'fixture' ? fixtureProvenance : liveProvenance;

  async function request<T>(input: ApiRequest<T>): Promise<ApiResult<T>> {
    const method = input.method ?? 'GET';
    const path = safePath(input.path);
    const endpointAuth = defaultAuth(method, path);
    const auth = input.auth ?? endpointAuth;
    if (endpointAuth === 'required' && auth !== 'required') {
      throw new TypeError('This API endpoint requires Firebase authentication.');
    }
    if ((input.requiresOperationKey || requiresIdempotencyKey(method, path)) && !input.operation) {
      throw new TypeError('This mutation requires an in-memory operation key scope.');
    }
    if (input.body !== undefined && !input.bodySchema) {
      throw new TypeError('JSON request bodies require a shared request schema.');
    }
    if (input.rawBody && (input.body !== undefined || input.bodySchema || method !== 'PUT')) {
      throw new TypeError('Raw request bodies are only supported for schema-validated upload PUTs.');
    }

    const body = input.rawBody ?? (input.bodySchema ? input.bodySchema.parse(input.body) : undefined);
    const headers = new Headers({ Accept: 'application/json' });
    if (input.rawBody) {
      if (input.rawBody.type !== 'image/jpeg' || input.rawBody.size < 1) {
        throw new TypeError('Raw upload bodies must be non-empty JPEG images.');
      }
      headers.set('Content-Type', 'image/jpeg');
    } else if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (input.operation) headers.set('Idempotency-Key', UuidSchema.parse(input.operation.key));

    if (mode === 'fixture') {
      const fixture = await fixtureResolver({ method, path, body });
      if (!isAcceptedStatus(fixture.status, input.acceptedStatuses)) {
        throw errorFromPayload(fixture.status, fixture.body, new Headers(fixture.headers).get('Retry-After'));
      }
      return parseSuccess(fixture.status, fixture.body, input.responseSchema, provenance);
    }

    const tokenProvider = options.tokenProvider;
    let token: string | null = null;
    if (auth !== 'none' && tokenProvider) {
      try {
        token = await tokenProvider.getIdToken(false);
      } catch (cause) {
        if (auth === 'required') {
          throw new ApiClientError({
            code: 'UNAVAILABLE',
            message: 'Sign-in could not be checked. Try again.',
            retryable: true,
            cause,
          });
        }
      }
    }
    if (auth === 'required' && !token) {
      throw new ApiClientError({
        code: 'UNAUTHENTICATED',
        message: 'Sign in to continue.',
        retryable: false,
        status: 401,
      });
    }
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const init: RequestInit = {
      method,
      headers,
      body: input.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: input.signal,
    };
    const url = `${apiBasePath}${path}`;
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch (cause) {
      throw new ApiClientError({
        code: 'UNAVAILABLE',
        message: 'The service could not be reached. Try again using the same action.',
        retryable: true,
        cause,
      });
    }

    if (response.status === 401 && token && tokenProvider && auth !== 'none') {
      let refreshedToken: string | null = null;
      try {
        refreshedToken = await tokenProvider.getIdToken(true);
      } catch {
        refreshedToken = null;
      }
      if (refreshedToken) {
        headers.set('Authorization', `Bearer ${refreshedToken}`);
        try {
          response = await fetcher(url, init);
        } catch (cause) {
          throw new ApiClientError({
            code: 'UNAVAILABLE',
            message: 'The service could not be reached after refreshing sign-in. Retry the same action.',
            retryable: true,
            cause,
          });
        }
      }
    }

    const accepted = isAcceptedStatus(response.status, input.acceptedStatuses);
    if (!accepted) throw await errorFromResponse(response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw invalidResponse(response.status, cause);
    }
    return parseSuccess(response.status, payload, input.responseSchema, provenance);
  }

  async function uploadPhoto(ticketInput: unknown, photo: Blob): Promise<ApiResult<Infer<typeof UploadResultSchema>>> {
    const ticket = UploadTicketSchema.parse(ticketInput);
    if (photo.type !== 'image/jpeg' || photo.size < 1 || photo.size > ticket.maxBytes) {
      throw new TypeError('Photo does not match the upload ticket size and JPEG requirements.');
    }
    let uploadUrl: URL;
    try {
      uploadUrl = new URL(ticket.uploadUrl);
    } catch (cause) {
      throw invalidResponse(undefined, cause);
    }
    const expectedPath = `${apiBasePath}/uploads/${ticket.photoId}/content`;
    if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password || uploadUrl.hash
      || uploadUrl.pathname !== expectedPath || uploadUrl.searchParams.size !== 1
      || uploadUrl.searchParams.getAll('ticket').length !== 1 || !uploadUrl.searchParams.get('ticket')) {
      throw invalidResponse(undefined, new TypeError('Upload URL does not match the expected same-origin ticket.'));
    }
    const path = `${uploadUrl.pathname.slice(apiBasePath.length)}${uploadUrl.search}`;
    const result = await request({
      path,
      method: 'PUT',
      rawBody: photo,
      responseSchema: UploadResultSchema,
      acceptedStatuses: [200, 201],
    });
    if (result.data.photoId !== ticket.photoId) {
      throw invalidResponse(result.status, new TypeError('Upload response does not match its ticket.'));
    }
    return result;
  }

  return { request, uploadPhoto, mode };
}
