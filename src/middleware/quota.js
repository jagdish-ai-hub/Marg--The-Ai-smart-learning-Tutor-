/**
 * @file Enforces how many messages a student gets for free.
 *
 * Guests get a small lifetime taste (`GUEST_MESSAGE_LIMIT`, default 10) with
 * no account at all. Signing in with Google raises that to a real daily
 * allowance (`SIGNED_IN_DAILY_MESSAGE_LIMIT`, default 30), tracked in Postgres
 * so it survives restarts. There is no paid tier yet — this is the whole
 * monetisation story for now: free, with a reason to make an account.
 *
 * Mount this after `requireAuth` (it reads `req.user`) on every route that
 * costs an AI call the student directly triggers: starting a session,
 * asking, checking, hinting, explaining, revealing.
 *
 * @example
 * v1.post('/sessions/:id/ask', aiLimiter, requireAuth, asyncHandler(enforceMessageQuota), ...);
 */

import { ApiError } from '../utils/ApiError.js';
import { store } from '../store/index.js';
import { pgUsers } from '../store/pgUsers.js';
import { env } from '../config/env.js';

/**
 * Counts this request against the caller's message quota, rejecting it once
 * they are over.
 *
 * @param {import('express').Request} req - The request, with `req.user` set.
 * @param {import('express').Response} res - The response.
 * @param {import('express').NextFunction} next - Pass control onward.
 * @returns {Promise<void>}
 * @throws {ApiError} `GUEST_LIMIT_REACHED` or `DAILY_LIMIT_REACHED`.
 */
export async function enforceMessageQuota(req, res, next) {
  if (req.user.isGuest) {
    const count = await store.users.incrementMessageCount(req.user.id);
    if (count > env.GUEST_MESSAGE_LIMIT) {
      return next(ApiError.quotaExceeded(
        'GUEST_LIMIT_REACHED',
        `You've used all ${env.GUEST_MESSAGE_LIMIT} free guest messages. `
          + `Sign in with Google for ${env.SIGNED_IN_DAILY_MESSAGE_LIMIT} messages a day.`,
      ));
    }
  } else {
    const count = await pgUsers.incrementDailyMessageCount(req.user.id);
    if (count > env.SIGNED_IN_DAILY_MESSAGE_LIMIT) {
      return next(ApiError.quotaExceeded(
        'DAILY_LIMIT_REACHED',
        `You've used today's ${env.SIGNED_IN_DAILY_MESSAGE_LIMIT} free messages. Come back tomorrow for more.`,
      ));
    }
  }
  next();
}
