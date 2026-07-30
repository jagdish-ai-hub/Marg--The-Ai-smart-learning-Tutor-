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
