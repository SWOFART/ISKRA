import { deleteApp, initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  browserPopupRedirectResolver, browserSessionPersistence, createUserWithEmailAndPassword, getAuth, GoogleAuthProvider,
  initializeAuth, inMemoryPersistence, updateCurrentUser, type Auth,
  onAuthStateChanged, sendPasswordResetEmail, setPersistence, signInWithEmailAndPassword,
  signInWithPopup, signOut, type UserCredential,
} from 'firebase/auth';
import { BootstrapReceiptSchema, BootstrapRequestSchema } from '../shared/contracts';
import { createClientApi } from './api';
import type { MessageKey } from './i18n';

function browserConfig(): FirebaseOptions | undefined {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;
  return apiKey && authDomain && projectId && appId ? { apiKey, authDomain, projectId, appId } : undefined;
}

export function createFirebaseSession(config = browserConfig()) {
  if (!config) return undefined;
  const firebaseConfig = config;
  const auth = getAuth(initializeApp(config));
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  let attempt: { app: ReturnType<typeof initializeApp>; generation: number } | undefined;
  let committing: Promise<void> | undefined;
  let leaving: Promise<void> | undefined;
  let generation = 0;
  let initialized = false;
  const ready = setPersistence(auth, browserSessionPersistence)
    .then(() => auth.authStateReady())
    .then(() => { initialized = true; notify(); });
  // Keep a failed initialization handled until the user opens sign-in.
  void ready.catch(notify);
  onAuthStateChanged(auth, notify);

  async function login(action: (isolated: Auth) => Promise<UserCredential>) {
    if (attempt || committing || leaving || !initialized) throw { code: 'auth/operation-not-allowed' };
    const current = { app: initializeApp(firebaseConfig, `iskra-signin-${crypto.randomUUID()}`), generation: ++generation };
    const isolated = initializeAuth(current.app, {
      persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver,
    });
    attempt = current;
    notify();
    try {
      // Isolate pending SDK state so a cancelled completion cannot replace a later session.
      const credential = await action(isolated);
      if (current.generation !== generation) throw { code: 'auth/popup-closed-by-user' };
      const commit = updateCurrentUser(auth, credential.user);
      committing = commit;
      try { await commit; } finally { if (committing === commit) committing = undefined; }
      if (current.generation !== generation) throw { code: 'auth/popup-closed-by-user' };
      return credential;
    } finally {
      if (attempt === current) attempt = undefined;
      await deleteApp(current.app).catch(() => {});
      notify();
    }
  }

  const tokenProvider = {
    async getIdToken(forceRefresh: boolean) {
      await ready;
      return auth.currentUser?.getIdToken(forceRefresh) ?? null;
    },
  };
  const api = createClientApi({ mode: 'live', tokenProvider });
  return {
    ready,
    ...tokenProvider,
    get uid() { return auth.currentUser?.uid ?? null; },
    get busy() { return !!(attempt || committing || leaving); },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    signInEmail: (email: string, password: string) => login((isolated) => signInWithEmailAndPassword(isolated, email, password)),
    createAccount: (email: string, password: string) => login((isolated) => createUserWithEmailAndPassword(isolated, email, password)),
    signInGoogle: () => login((isolated) => signInWithPopup(isolated, new GoogleAuthProvider())),
    async signOut() {
      if (leaving) return leaving;
      generation += 1;
      const cancelled = attempt;
      attempt = undefined;
      if (cancelled) void deleteApp(cancelled.app).catch(() => {});
      const commit = committing;
      leaving = (async () => { await commit?.catch(() => {}); await signOut(auth); })();
      notify();
      try { await leaving; } finally { leaving = undefined; notify(); }
    },
    resetPassword: (email: string) => sendPasswordResetEmail(auth, email),
    async bootstrap() {
      return (await api.request({
        path: '/me/bootstrap', method: 'POST', body: {}, bodySchema: BootstrapRequestSchema,
        responseSchema: BootstrapReceiptSchema,
      })).data;
    },
  };
}

export type FirebaseSession = NonNullable<ReturnType<typeof createFirebaseSession>>;

export function authErrorMessage(error: unknown): MessageKey {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'auth/popup-blocked') return 'auth.popupBlocked';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'auth.cancelled';
  if (code === 'auth/weak-password' || code === 'auth/password-does-not-meet-requirements') return 'auth.weakPassword';
  if (code === 'auth/too-many-requests') return 'error.RATE_LIMITED';
  if (code === 'auth/network-request-failed') return 'auth.networkError';
  return 'auth.signInError';
}
