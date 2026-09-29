/**
 * Session state.
 *
 * The server is the authority on who you are and what you may do; this store is
 * a cache of the last answer, never a source of truth. Every guard re-checks with
 * the backend rather than trusting `role` here — the admin routes answer 404 to a
 * non-admin regardless of what this store believes.
 */
import { create } from 'zustand';
import {
  api,
  ApiError,
  setCsrf,
  type Entitlement,
  type Me,
  type RegisterResult,
} from './api';

interface SessionState {
  me: Me | null;
  /** null until the first /api/auth/me has resolved, so guards can wait rather
   *  than briefly redirecting a signed-in user to the login page. */
  status: 'loading' | 'signed-in' | 'signed-out';
  refresh: () => Promise<Me | null>;
  signIn: (email: string, password: string) => Promise<Me>;
  /**
   * `consent` is the purpose -> granted map collected on the signup form.
   *
   * RESOLVES TO THE REGISTRATION, NOT TO A SESSION, because registering no longer
   * signs you in: the address has to be confirmed first. Read `verification_required`
   * on the result to decide between "check your inbox" and a redirect. It used to
   * return `Me`, and the type changed on purpose so that every caller had to be
   * looked at rather than silently receiving something it no longer gets.
   */
  signUp: (
    email: string,
    password: string,
    consent?: Record<string, boolean>,
  ) => Promise<RegisterResult>;
  signOut: () => Promise<void>;
  setEntitlement: (e: Entitlement) => void;
}

export const useSession = create<SessionState>((set, get) => ({
  me: null,
  status: 'loading',

  refresh: async () => {
    try {
      const me = await api.auth.me();
      setCsrf(me.csrf);
      set({ me, status: 'signed-in' });
      return me;
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthenticated) {
        setCsrf(null);
        set({ me: null, status: 'signed-out' });
        return null;
      }
      // A network failure is not a sign-out. Keep whoever we had and let the
      // caller surface the error, or a flaky connection logs people out.
      set({ status: get().me ? 'signed-in' : 'signed-out' });
      throw err;
    }
  },

  signIn: async (email, password) => {
    const res = await api.auth.login(email, password);
    setCsrf(res.csrf);
    const me = await api.auth.me();
    setCsrf(me.csrf);
    set({ me, status: 'signed-in' });
    return me;
  },

  signUp: async (email, password, consent) => {
    const res = await api.auth.register(email, password, consent);
    // No CSRF token means no session, which is the normal path now: the address is
    // unconfirmed and the emailed link is the next step. Nothing is set here, so the
    // store stays signed-out and the guards keep working unchanged.
    //
    // The exception is the operator's first account on a fresh database — confirmed at
    // creation, so it does come back with a session and is signed straight in.
    const csrf = res.csrf;
    if (!csrf) return res;
    setCsrf(csrf);
    // register returns no entitlement, so /me is the only way to learn the plan
    const me = await api.auth.me();
    setCsrf(me.csrf);
    set({ me, status: 'signed-in' });
    return res;
  },

  signOut: async () => {
    try {
      await api.auth.logout();
    } finally {
      setCsrf(null);
      set({ me: null, status: 'signed-out' });
    }
  },

  setEntitlement: (entitlement) => {
    const me = get().me;
    if (me) set({ me: { ...me, entitlement } });
  },
}));

export const isAdmin = (me: Me | null) => me?.role === 'admin';
