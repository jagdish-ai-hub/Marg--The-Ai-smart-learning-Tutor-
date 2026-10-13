/**
 * "Sign in with Google" — via Neon's Managed Better Auth.
 *
 * WHY THIS EXISTS
 * Guests get a small free taste with no account at all (see marg-client.js's
 * `ready()`). Signing in with Google raises the daily message limit — see
 * the backend's `src/middleware/quota.js`. Neon's Managed Better Auth runs
 * the whole OAuth dance — including, for Google specifically, shared
 * credentials that need no Google Cloud Console app of your own — so this
 * file is mostly plumbing: start the sign-in, and once it completes, hand
 * the resulting token to the Marg backend (`marg.signInWithGoogle()` in
 * marg-client.js) to get a Marg account.
 *
 * Loaded from esm.sh rather than npm, because this is a no-build-step,
 * plain-script frontend — see docs/FRONTEND-GUIDE.md. If that ever changes,
 * swap the dynamic import below for a static `import { createAuthClient }
 * from '@neondatabase/neon-js/auth'` and nothing else in this file moves.
 *
 * THE IMPORT IS DELIBERATELY LAZY, NOT AT THE TOP OF THIS FILE
 * This file is imported by `shell.js`, which every page (app.html,
 * session.html, insights.html) imports. A `import … from 'https://esm.sh/…'`
 * at the top would make a slow or blocked CDN break the *entire* module
 * graph — guest mode included — for every visitor, over a feature most of
 * them aren't even using yet. Loading it inside the functions that actually
 * need it means a CDN hiccup only ever degrades "Sign in with Google"
 * itself; everything else keeps working.
 *
 * @example
 * import * as googleAuth from './auth.js';
 * if (googleAuth.isConfigured) signInBtn.hidden = false;
 * signInBtn.addEventListener('click', () => googleAuth.signInWithGoogle());
 */

import { NEON_AUTH_URL } from './config.js';

/** True once a real Neon Auth project is configured — see config.js. */
export const isConfigured = Boolean(NEON_AUTH_URL);

/** @type {Promise<ReturnType<typeof import('https://esm.sh/@neondatabase/neon-js/auth')['createAuthClient']>>|null} */
let clientPromise = null;

/** @private @returns {Promise<ReturnType<typeof import('https://esm.sh/@neondatabase/neon-js/auth')['createAuthClient']>>} */
function authClient() {
  if (!clientPromise) {
    clientPromise = import('https://esm.sh/@neondatabase/neon-js/auth')
      .then(({ createAuthClient }) => createAuthClient(NEON_AUTH_URL));
  }
  return clientPromise;
}

/**
 * Starts the Google sign-in flow. This redirects the browser away and back
 * — nothing after this call runs until the page reloads at `callbackURL`.
 *
 * @returns {Promise<void>}
 */
export async function signInWithGoogle() {
  if (!isConfigured) return;
  const client = await authClient();
  await client.signIn.social({ provider: 'google', callbackURL: window.location.href });
}

/**
 * Checks whether a Google session is currently active. Safe to call on
 * every page load — Better Auth persists the session itself via its own
 * cookie, so there is nothing special to do right after the OAuth redirect
 * beyond calling this as usual.
 *
 * @returns {Promise<{email: string}|null>} The signed-in user, or `null`.
 */
export async function getGoogleSession() {
  if (!isConfigured) return null;
  const client = await authClient();
  const { data } = await client.getSession();
  return data?.user?.email ? { email: data.user.email } : null;
}

/**
 * Gets a short-lived Neon Auth JWT for the current Google session, to hand
 * to `POST /auth/google` (see marg-client.js's `signInWithGoogle()`).
 *
 * @returns {Promise<string|null>} The raw JWT, or `null` if not signed in.
 */
export async function getGoogleToken() {
  if (!isConfigured) return null;
  const client = await authClient();
  const { data } = await client.token();
  return data?.token ?? null;
}

/**
 * Signs out of the Google session itself. Call this alongside
 * `marg.signOut()` (which drops the separate Marg account token) so both
 * halves of the sign-in agree the student is signed out.
 *
 * @returns {Promise<void>}
 */
export async function signOutOfGoogle() {
  if (!isConfigured) return;
  const client = await authClient();
  await client.signOut();
}
