/**
 * @file Anonymous guest authentication.
 *
 * HOW IT WORKS, IN ONE PARAGRAPH
 * There is no signup. The frontend calls `POST /auth/guest` once, gets back a
 * token, saves it in localStorage, and sends it as `Authorization: Bearer …`
 * on every later request. That is the whole flow. It matches the landing page's
 * promise — free to start, no credit card, no scheduling a slot — because
 * asking someone to create an account before they can ask a question is
 * exactly the friction the product exists to remove.
 *
 * The token is a JWT: a signed blob containing the user id. Signed, not
 * encrypted — anyone can read what is inside, but nobody can change it without
 * the secret. So it must never carry anything private, and it does not: just
 * the user id and an expiry.
 *
 * Adding real accounts later means adding an email/password route that issues
 * the same kind of token. Nothing else in the codebase has to change.
 */

import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { store } from '../store/index.js';

/**
 * Creates a signed token for a user.
 *
 * @param {object} user - The user record. Only `id` is used.
 * @returns {{token: string, expiresAt: string}} The token and when it expires.
 *
 * @example
 * const { token } = issueToken(user);
 * // Frontend sends: Authorization: Bearer <token>
 */
export function issueToken(user) {
  const token = jwt.sign(
    { sub: user.id, guest: true },
    env.JWT_SECRET,
    { expiresIn: env.JWT_TTL },
  );

  // Decode our own token to read the expiry the library calculated, rather than
  // parsing "30d" ourselves and risking the two disagreeing.
  const { exp } = jwt.decode(token);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Reads the bearer token from a request.
 *
 * Also accepts `?token=` in the query string, because the browser's
 * `EventSource` cannot set headers. That is a real limitation of the SSE API,
 * not a shortcut — without it, streaming would need a custom `fetch` client on
 * every frontend. Query tokens can end up in server access logs, so this is
 * accepted only on the streaming route.
 *
 * @private
 * @param {import('express').Request} req - The request.
 * @returns {string|null} The token, or `null`.
 */
function extractToken(req) {
  const header = req.get('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  if (typeof req.query.token === 'string' && req.query.token) return req.query.token;
  return null;
}

/**
 * Rejects the request unless it carries a valid token.
 *
 * On success, sets `req.user` to the user record.
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @param {import('express').NextFunction} next - Pass control onward.
 * @returns {Promise<void>}
 * @throws {ApiError} `UNAUTHENTICATED` if the token is missing, invalid, or expired.
 */
export async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return next(ApiError.unauthenticated());
  }

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (error) {
    return next(ApiError.unauthenticated(
      error.name === 'TokenExpiredError'
        ? 'Your session has expired. Call POST /api/v1/auth/guest for a new token.'
        : 'That token is not valid. Call POST /api/v1/auth/guest for a new one.',
    ));
  }

  const user = await store.users.findById(payload.sub);
  if (!user) {
    // The signature was valid but the user is gone — which happens routinely
    // with the in-memory store, since a restart wipes every user while the
    // tokens in browsers stay valid. Treat it as expired so the frontend's
    // normal 401 handling gets a fresh guest account.
    return next(ApiError.unauthenticated(
      'That account no longer exists. Call POST /api/v1/auth/guest for a new token.',
    ));
  }

  await store.users.touch(user.id);
  req.user = user;
  next();
}
