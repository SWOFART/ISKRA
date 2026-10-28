import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../../fixtures/contracts/p0.json';

const sdk = vi.hoisted(() => {
  const user = { uid: 'firebase-test-user', getIdToken: vi.fn(async () => 'test-id-token') };
  const auth = { currentUser: null as typeof user | null, authStateReady: vi.fn(async () => {}) };
  return {
    user, auth,
    initializeApp: vi.fn(), setPersistence: vi.fn(async () => {}), onAuthStateChanged: vi.fn(),
    email: vi.fn(async () => { auth.currentUser = user; return { user }; }),
    signup: vi.fn(async () => { auth.currentUser = user; return { user }; }),
    google: vi.fn(async () => { auth.currentUser = user; return { user }; }),
    signOut: vi.fn(async () => { auth.currentUser = null; }), reset: vi.fn(async () => {}),
  };
});
vi.mock('firebase/app', () => ({ initializeApp: sdk.initializeApp }));
vi.mock('firebase/auth', () => ({
  getAuth: () => sdk.auth, browserSessionPersistence: 'session',
  setPersistence: sdk.setPersistence, onAuthStateChanged: sdk.onAuthStateChanged,
  signInWithEmailAndPassword: sdk.email, createUserWithEmailAndPassword: sdk.signup,
  signInWithPopup: sdk.google, GoogleAuthProvider: class {}, signOut: sdk.signOut,
  sendPasswordResetEmail: sdk.reset,
}));
import { authErrorMessage, createFirebaseSession } from '../../../src/client/auth';

const config = { apiKey: 'test-key', projectId: 'iskra-test', authDomain: 'iskra-test.firebaseapp.com', appId: 'test-app' };
beforeEach(() => { vi.clearAllMocks(); sdk.auth.currentUser = null; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Firebase session boundary', () => {
  it('does not initialize a provider when browser configuration is missing', () => {
    expect(createFirebaseSession()).toBeUndefined();
    expect(sdk.initializeApp).not.toHaveBeenCalled();
  });
  it('uses session persistence and passes bounded token refresh requests to Firebase', async () => {
    const session = createFirebaseSession(config)!;
    await session.ready;
    expect(sdk.setPersistence).toHaveBeenCalledWith(sdk.auth, 'session');
    expect(await session.getIdToken(false)).toBeNull();
    await session.signInEmail('resident@example.test', 'test-password');
    expect(await session.getIdToken(true)).toBe('test-id-token');
    expect(sdk.user.getIdToken).toHaveBeenCalledWith(true);
  });
  it('always sends bootstrap to the live authenticated API and validates its receipt', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fixtures.bootstrap), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const session = createFirebaseSession(config)!;
    await session.ready;
    await session.signInGoogle();
    expect(await session.bootstrap()).toEqual(fixtures.bootstrap);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/me/bootstrap');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-id-token');
    expect(init.body).toBe('{}');
  });
  it('signs out a late Firebase completion after the user cancelled the attempt', async () => {
    let finish!: (value: { user: typeof sdk.user }) => void;
    sdk.email.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const session = createFirebaseSession(config)!;
    await session.ready;
    const attempt = session.signInEmail('resident@example.test', 'test-password');
    expect(session.busy).toBe(true);
    await session.signOut();
    sdk.auth.currentUser = sdk.user;
    finish({ user: sdk.user });
    await expect(attempt).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
    expect(session.uid).toBeNull();
    expect(session.busy).toBe(false);
    expect(sdk.signOut).toHaveBeenCalledTimes(2);
  });
  it('maps provider errors to safe localized keys without echoing provider details', () => {
    expect(authErrorMessage({ code: 'auth/popup-blocked', message: 'private provider body' })).toBe('auth.popupBlocked');
    expect(authErrorMessage(new Error('private provider body'))).toBe('auth.signInError');
  });
});
