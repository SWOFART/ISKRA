import { initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  browserSessionPersistence, createUserWithEmailAndPassword, getAuth, GoogleAuthProvider,
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
  const auth = getAuth(initializeApp(config));
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  let pending = false;
  let generation = 0;
  let initialized = false;
  const ready = setPersistence(auth, browserSessionPersistence)
    .then(() => auth.authStateReady())
    .then(() => { initialized = true; notify(); });
  // Keep a failed initialization handled until the user opens sign-in.
  void ready.catch(notify);
  onAuthStateChanged(auth, notify);

  async function login(action: () => Promise<UserCredential>) {
    if (pending || !initialized) throw { code: 'auth/operation-not-allowed' };
    const attempt = ++generation;
    pending = true;
    notify();
    // Invoke immediately so a Google popup keeps the browser's user activation.
    try {
      const credential = await action();
      if (attempt !== generation) {
        await signOut(auth);
        throw { code: 'auth/popup-closed-by-user' };
      }
      return credential;
    } finally { pending = false; notify(); }
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
    get busy() { return pending; },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    signInEmail: (email: string, password: string) => login(() => signInWithEmailAndPassword(auth, email, password)),
    createAccount: (email: string, password: string) => login(() => createUserWithEmailAndPassword(auth, email, password)),
    signInGoogle: () => login(() => signInWithPopup(auth, new GoogleAuthProvider())),
    async signOut() { generation += 1; await signOut(auth); },
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
