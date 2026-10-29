import { importPKCS8, SignJWT } from 'jose';

export type GoogleIdentity = {
  projectId: string; issuer: string; subject: string; audience: string; environment: string;
  serviceAccountEmail: string; privateKey: string; keyId: string;
};
const STS_URL = 'https://sts.googleapis.com/v1/token';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function unavailable(): never { throw new Error('Google authentication is unavailable.'); }
function timedOut(): never {
  const error = new Error('Google authentication timed out.'); error.name = 'TimeoutError'; throw error;
}

export function parseGoogleIdentity(raw: string): GoogleIdentity {
  if (typeof raw !== 'string' || raw.length > 16_384) unavailable();
  let identity: unknown;
  try { identity = JSON.parse(raw); } catch { return unavailable(); }
  if (!isRecord(identity) || typeof identity.projectId !== 'string'
    || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(identity.projectId)
    || typeof identity.serviceAccountEmail !== 'string'
    || !identity.serviceAccountEmail.endsWith('@' + identity.projectId + '.iam.gserviceaccount.com')
    || !/^[a-z][a-z0-9-]+@/.test(identity.serviceAccountEmail)
    || typeof identity.audience !== 'string'
    || !/^\/\/iam\.googleapis\.com\/projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(identity.audience)
    || typeof identity.issuer !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(identity.issuer)
    || typeof identity.subject !== 'string' || !/^[a-zA-Z0-9:_-]{1,127}$/.test(identity.subject)
    || !['staging', 'production'].includes(String(identity.environment))
    || typeof identity.keyId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(identity.keyId)
    || typeof identity.privateKey !== 'string' || !identity.privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n')
    || !identity.privateKey.trimEnd().endsWith('-----END PRIVATE KEY-----')) unavailable();
  return identity as GoogleIdentity;
}

/** Bound JSON authentication/metadata replies; never expose provider response bodies. */
export async function readGoogleJson(response: Response, maximumBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return unavailable();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) return unavailable();
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(value)) return unavailable();
    return value;
  } finally { void reader.cancel().catch(() => {}); }
}

async function authResponse(response: Response) {
  if (!response.ok) { try { await response.body?.cancel(); } catch {} return unavailable(); }
  try {
    const value: unknown = await readGoogleJson(response);
    if (isRecord(value)) return value;
  } catch (error) {
    if (isRecord(error) && ['AbortError', 'TimeoutError'].includes(String(error.name))) timedOut();
  }
  return unavailable();
}

export async function googleAccessToken(identity: GoogleIdentity, fetcher: typeof fetch, signal: AbortSignal) {
  const assertion = await new SignJWT({ environment: identity.environment })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: identity.keyId })
    .setIssuer(identity.issuer).setSubject(identity.subject).setAudience(identity.audience)
    .setIssuedAt().setExpirationTime('5m').sign(await importPKCS8(identity.privateKey, 'RS256'));
  const federated = await authResponse(await fetcher(STS_URL, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ audience: identity.audience,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', subject_token: assertion }).toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  }));
  if (federated.token_type !== 'Bearer' || typeof federated.access_token !== 'string'
    || !/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(federated.access_token)) unavailable();
  const token = await authResponse(await fetcher(
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'
      + encodeURIComponent(identity.serviceAccountEmail) + ':generateAccessToken', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + federated.access_token },
      body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '900s' }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    },
  ));
  if (typeof token.accessToken !== 'string' || !/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(token.accessToken)
    || typeof token.expireTime !== 'string' || !Number.isFinite(Date.parse(token.expireTime))
    || Date.parse(token.expireTime) <= Date.now()
    || Date.parse(token.expireTime) > Date.now() + 930_000) unavailable();
  return token.accessToken;
}
