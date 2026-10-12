/**
 * @file Guest authentication endpoints.
 *
 * FOR THE FRONTEND, THE WHOLE FLOW IS:
 *   1. On first load, if you have no stored token, call `POST /auth/guest`.
 *   2. Save `data.token` in localStorage.
 *   3. Send `Authorization: Bearer <token>` on every request after that.
 *   4. If any request returns 401, go back to step 1 and retry once.
 *
 * That is it. No signup form, no password, no email.
 */

import { store } from '../store/index.js';
import { issueToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { pgUsers } from '../store/pgUsers.js';
import { verifyNeonAuthToken } from '../services/googleAuth.js';

/**
 * `POST /api/v1/auth/guest` — creates an anonymous account.
 *
 * Auth: none required (this is how you get a token).
 * Body: none.
 * Returns: `{ user, token, expiresAt }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function createGuest(req, res) {
  const user = await store.users.create();
  const { token, expiresAt } = issueToken(user);

  logger.info('Guest user created', { userId: user.id });

  res.ok({
    user: { id: user.id, isGuest: true, createdAt: user.createdAt },
    token,
    expiresAt,
  }, 201);
}

/**
 * `POST /api/v1/auth/refresh` — exchanges a valid token for a fresh one.
 *
 * Call this when the current token is within a few days of expiring, so a
 * student who uses the app daily never gets logged out mid-session.
 *
 * Auth: required.
 * Body: none.
 * Returns: `{ user, token, expiresAt }`
 *
 * @param {import('express').Request} req - The request, with `req.user` set.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function refresh(req, res) {
  const { token, expiresAt } = issueToken(req.user);
  res.ok({
    user: { id: req.user.id, isGuest: req.user.isGuest, createdAt: req.user.createdAt },
    token,
    expiresAt,
  });
}

/**
 * `GET /api/v1/auth/me` — returns the current user.
 *
 * Useful as a cheap "is my stored token still good?" check on app startup.
 *
 * Auth: required.
 * Returns: `{ user }`
 *
 * @param {import('express').Request} req - The request, with `req.user` set.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function me(req, res) {
  res.ok({
    user: {
      id: req.user.id,
      isGuest: req.user.isGuest,
      createdAt: req.user.createdAt,
      lastSeenAt: req.user.lastSeenAt,
    },
  });
}

/**
 * `POST /api/v1/auth/google` — exchanges a Google sign-in for a Marg account.
 *
 * FOR THE FRONTEND:
 *   1. Run the Google sign-in flow with Neon's Managed Better Auth SDK.
 *   2. Call `authClient.token()` to get a short-lived Neon Auth JWT.
 *   3. POST it here as `{ neonAuthToken }`.
 *   4. Save the returned `data.token` exactly like a guest token — same
 *      shape, same `Authorization: Bearer …` usage on every later request.
 *
 * The student's first sign-in creates their account; every later sign-in
 * just finds it again, so this one endpoint handles both.
 *
 * Auth: none required (this is how a signed-in student gets their first Marg
 * token, same role `POST /auth/guest` plays for guests).
 * Body: `{ neonAuthToken: string }`
 * Returns: `{ user, token, expiresAt }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function google(req, res) {
  const { id, email } = await verifyNeonAuthToken(req.body.neonAuthToken);
  const user = await pgUsers.findOrCreate({ id, email });
  const { token, expiresAt } = issueToken({ id: user.id, isGuest: false });

  logger.info('Signed-in user authenticated', { userId: user.id });

  res.ok({
    user: { id: user.id, isGuest: false, email: user.email, createdAt: user.createdAt },
    token,
    expiresAt,
  });
}
