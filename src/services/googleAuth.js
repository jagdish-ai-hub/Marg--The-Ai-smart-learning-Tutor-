/**
 * @file Verifies the token Neon Auth issues after a student signs in with Google.
 *
 * THE FLOW, END TO END
 *   1. The frontend's "Sign in with Google" button is handled entirely by
 *      Neon's Managed Better Auth (see frontend/js/auth.js) — Marg's backend
 *      is not involved in the OAuth dance itself.
 *   2. Once signed in, the frontend asks Neon Auth for a short-lived JWT
 *      (`authClient.token()`) and sends it to `POST /api/v1/auth/google`.
 *   3. This file checks that JWT is genuinely signed by Neon Auth, using the
 *      public keys at its JWKS endpoint — the same trust model `jsonwebtoken`
 *      uses for our own tokens, just with the key fetched over HTTPS instead
 *      of shared in `JWT_SECRET`.
 *   4. `auth.controller.js` then issues Marg's own guest-style token for that
 *      user, so nothing downstream needs to know Google was ever involved.
 *
 * @example
 * const { id, email } = await verifyNeonAuthToken(rawTokenFromFrontend);
 */

import { jwtVerify, createRemoteJWKSet } from 'jose';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Lazily built and cached so every request reuses the same key fetcher
 * (which itself caches the keys) instead of re-resolving the JWKS URL.
 *
 * @private
 * @type {ReturnType<typeof createRemoteJWKSet>|null}
 */
let jwks = null;

/**
 * @private
 * @returns {ReturnType<typeof createRemoteJWKSet>}
 */
function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.NEON_AUTH_BASE_URL}/.well-known/jwks.json`));
  }
  return jwks;
}

/**
 * Verifies a Neon Auth JWT and extracts the identity Marg cares about.
 *
 * @param {string} token - The raw JWT from `authClient.token()` on the frontend.
 * @returns {Promise<{id: string, email: string}>} The verified user id and email.
 * @throws {ApiError} `SIGNIN_UNAVAILABLE` if Google sign-in is not configured;
 *   `UNAUTHENTICATED` if the token is missing, expired, or not genuinely
 *   signed by Neon Auth.
 */
export async function verifyNeonAuthToken(token) {
  if (!env.NEON_AUTH_BASE_URL) {
    throw ApiError.unavailable(
      'Google sign-in is not set up on this server. Set DATABASE_URL and NEON_AUTH_BASE_URL — see .env.example.',
    );
  }
  if (!token) {
    throw ApiError.unauthenticated('No Google sign-in token was sent.');
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(), {
      issuer: new URL(env.NEON_AUTH_BASE_URL).origin,
    }));
  } catch {
    // Expired (tokens live 15 minutes), malformed, or not genuinely signed by
    // Neon Auth — all look the same to the caller: sign in again.
    throw ApiError.unauthenticated('That Google sign-in has expired or could not be verified. Please sign in again.');
  }

  if (!payload.email) {
    throw ApiError.unauthenticated('Google did not share an email address, so Marg cannot create an account.');
  }

  return { id: payload.sub, email: payload.email };
}
