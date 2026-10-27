import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createFirebaseKeyResolver, verifyFirebaseToken } from '../../../src/worker/middleware/auth';

const project = 'iskra-test';
let first: Awaited<ReturnType<typeof generateKeyPair>>;
let second: Awaited<ReturnType<typeof generateKeyPair>>;
let firstJwk: Awaited<ReturnType<typeof exportJWK>>;
let secondJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  first = await generateKeyPair('RS256', { extractable: true });
  second = await generateKeyPair('RS256', { extractable: true });
  firstJwk = { ...await exportJWK(first.publicKey), kid: 'first', alg: 'RS256', use: 'sig' };
  secondJwk = { ...await exportJWK(second.publicKey), kid: 'second', alg: 'RS256', use: 'sig' };
});

afterEach(() => vi.restoreAllMocks());

function sign(changes: JWTPayload = {}, key = first.privateKey, kid = 'first') {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: `https://securetoken.google.com/${project}`, aud: project,
    sub: 'resident-1', exp: now + 3600, iat: now - 10, auth_time: now - 20,
    email: 'private@example.test', ...changes,
  }).setProtectedHeader({ alg: 'RS256', kid }).sign(key);
}

function localKeys() {
  return createLocalJWKSet({ keys: [firstJwk] });
}

function keyResponse(keys = [firstJwk], headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ keys }), {
    headers: { 'Cache-Control': 'public, max-age=3600', ...headers },
  });
}

describe('Firebase ID token verification', () => {
  it('verifies signature and returns only UID, not provider private data', async () => {
    expect(await verifyFirebaseToken(await sign(), project, localKeys())).toEqual({ uid: 'resident-1' });
  });

  it.each([
    { iss: 'https://attacker.test' }, { aud: 'another-project' },
    { aud: [project, 'another-project'] }, { sub: '' }, { sub: 'x'.repeat(129) },
    { iat: Math.floor(Date.now() / 1000) + 3600 }, { iat: -1 },
    { auth_time: Math.floor(Date.now() / 1000) + 3600 }, { auth_time: -1 },
    { auth_time: undefined }, { exp: undefined }, { iat: undefined },
    { exp: 1 }, { nbf: Math.floor(Date.now() / 1000) + 3600 },
  ])('rejects invalid/missing claims %j', async (changes) => {
    await expect(verifyFirebaseToken(await sign(changes), project, localKeys())).rejects.toThrow();
  });

  it('rejects a wrong signature, unknown key and missing key ID', async () => {
    for (const token of [await sign({}, second.privateKey), await sign({}, first.privateKey, 'unknown'),
      await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).sign(first.privateKey)]) {
      await expect(verifyFirebaseToken(token, project, localKeys())).rejects.toThrow();
    }
  });

  it('rejects a different algorithm and oversized or malformed bearer content', async () => {
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', kid: 'first' })
      .sign(new Uint8Array(32));
    for (const value of [token, 'malformed', 'x'.repeat(16_385)]) {
      await expect(verifyFirebaseToken(value, project, localKeys())).rejects.toThrow();
    }
  });
});

describe('bounded Google key resolution', () => {
  it('shares one concurrent fetch and caches provider keys', async () => {
    const fetchKeys = vi.fn(async () => keyResponse());
    const keys = createFirebaseKeyResolver(fetchKeys);
    const token = await sign();
    await Promise.all(Array.from({ length: 5 }, () => verifyFirebaseToken(token, project, keys)));
    await verifyFirebaseToken(token, project, keys);
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it('allows one unknown-key refresh after cooldown, not one fetch per attacker key', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchKeys = vi.fn(async () => keyResponse());
    const keys = createFirebaseKeyResolver(fetchKeys);
    await verifyFirebaseToken(await sign(), project, keys);
    await expect(verifyFirebaseToken(await sign({}, second.privateKey, 'second'), project, keys)).rejects.toThrow();
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 31_000);
    fetchKeys.mockImplementation(async () => keyResponse([firstJwk, secondJwk]));
    expect(await verifyFirebaseToken(await sign({}, second.privateKey, 'second'), project, keys)).toEqual({ uid: 'resident-1' });
    expect(fetchKeys).toHaveBeenCalledTimes(2);
    await expect(verifyFirebaseToken(await sign({}, first.privateKey, 'other'), project, keys)).rejects.toThrow();
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it('honors provider cache lifetime and Age rather than serving expired keys', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchKeys = vi.fn(async () => keyResponse([firstJwk], { 'Cache-Control': 'max-age=40', Age: '5' }));
    const keys = createFirebaseKeyResolver(fetchKeys);
    await verifyFirebaseToken(await sign(), project, keys);
    clock.mockReturnValue(now + 34_000);
    await verifyFirebaseToken(await sign(), project, keys);
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 36_000);
    await verifyFirebaseToken(await sign(), project, keys);
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it('fails closed and cools down after unavailable keys', async () => {
    const fetchKeys = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const keys = createFirebaseKeyResolver(fetchKeys);
    await expect(verifyFirebaseToken(await sign(), project, keys)).rejects.toThrow();
    await expect(verifyFirebaseToken(await sign(), project, keys)).rejects.toThrow();
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it.each(['not-a-number', '-1'])('does not cache keys indefinitely for invalid Age %s', async (age) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchKeys = vi.fn(async () => keyResponse([firstJwk], { Age: age }));
    const keys = createFirebaseKeyResolver(fetchKeys);
    await verifyFirebaseToken(await sign(), project, keys);
    clock.mockReturnValue(now + 31_000);
    await verifyFirebaseToken(await sign(), project, keys);
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized key streams and malformed key sets', async () => {
    for (const text of ['x'.repeat(65_537), '{}', '{"keys":[]}', 'invalid-json']) {
      const keys = createFirebaseKeyResolver(vi.fn(async () => new Response(text)));
      await expect(verifyFirebaseToken(await sign(), project, keys)).rejects.toThrow();
    }
  });
});
