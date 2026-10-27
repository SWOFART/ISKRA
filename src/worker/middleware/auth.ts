import { createMiddleware } from 'hono/factory';
import {
  createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify,
  type JSONWebKeySet, type JWTVerifyGetKey,
} from 'jose';
import type { WorkerEnv } from './context';
import { ApiError } from './errors';

const KEY_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const REFRESH_COOLDOWN_MS = 30_000;

// Each Worker isolate shares a bounded key cache, never identity or user data.
export function createFirebaseKeyResolver(fetchKeys: typeof fetch = fetch): JWTVerifyGetKey {
  let resolver: ReturnType<typeof createLocalJWKSet> | undefined;
  let expiresAt = 0;
  let lastRefresh = -Infinity;
  let pending: Promise<void> | undefined;

  function refresh() {
    if (pending) return pending;
    if (Date.now() - lastRefresh < REFRESH_COOLDOWN_MS) {
      throw new Error('Signing key refresh is cooling down');
    }
    lastRefresh = Date.now();
    pending = (async () => {
      const response = await fetchKeys(KEY_URL, {
        signal: AbortSignal.timeout(5_000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Signing keys unavailable');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Signing key response is empty');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 65_536) throw new Error('Signing key response too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const jwks: JSONWebKeySet = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(jwks.keys) || jwks.keys.length === 0 || jwks.keys.length > 20) {
        throw new Error('Invalid signing keys');
      }
      const headers = response.headers;
      const maxAge = Number(headers.get('Cache-Control')?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 0);
      const age = Number(headers.get('Age') ?? 0);
      const noCache = /(?:no-store|no-cache)/i.test(headers.get('Cache-Control') ?? '');
      const lifetime = noCache || !Number.isFinite(maxAge) || !Number.isFinite(age) || age < 0
        ? 0 : Math.max(0, Math.min(300, maxAge - age));
      resolver = createLocalJWKSet(jwks);
      expiresAt = Date.now() + lifetime * 1_000;
    })().finally(() => { pending = undefined; });
    return pending;
  }

  return async (header, token) => {
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      throw new Error('Unsupported signing header');
    }
    let refreshed = false;
    if (!resolver || Date.now() >= expiresAt) {
      await refresh();
      refreshed = true;
    }
    try {
      return await resolver!(header, token);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey) || refreshed) throw error;
      await refresh();
      return resolver!(header, token);
    }
  };
}

const googleKeys = createFirebaseKeyResolver();

export async function verifyFirebaseToken(
  token: string,
  projectId: string,
  keys: JWTVerifyGetKey = googleKeys,
): Promise<{ uid: string }> {
  if (token.length > 16_384) throw new Error('Invalid token size');
  const header = decodeProtectedHeader(token);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new Error('Invalid token header');
  }
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    requiredClaims: ['exp', 'iat', 'auth_time', 'sub'],
  });
  const now = Math.floor(Date.now() / 1_000);
  if (payload.aud !== projectId
    || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 128
    || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat < 0 || payload.iat > now
    || typeof payload.auth_time !== 'number' || !Number.isFinite(payload.auth_time)
    || payload.auth_time < 0 || payload.auth_time > now) {
    throw new Error('Invalid Firebase claims');
  }
  return { uid: payload.sub };
}

type TokenVerifier = typeof verifyFirebaseToken;

export function requireAuth(verify: TokenVerifier = verifyFirebaseToken) {
  return createMiddleware<WorkerEnv>(async (c, next) => {
    const match = c.req.header('Authorization')?.match(/^Bearer ([^\s]+)$/i);
    if (!match) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const projectId = c.env.FIREBASE_PROJECT_ID;
    if (!projectId) throw new ApiError(503, 'UNAVAILABLE', 'Sign-in is not configured.', true);
    try {
      c.set('identity', await verify(match[1], projectId));
    } catch {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    }
    await next();
  });
}

export function optionalAuth(verify: TokenVerifier = verifyFirebaseToken) {
  const required = requireAuth(verify);
  return createMiddleware<WorkerEnv>(async (c, next) => {
    if (c.req.header('Authorization') !== undefined) return required(c, next);
    c.set('identity', undefined);
    await next();
  });
}
