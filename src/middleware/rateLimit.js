/**
 * @file Rate limits, so one user cannot exhaust the AI budget for everyone.
 *
 * Two tiers, because the costs are wildly different. Listing sessions touches a
 * Map; asking a question costs a real AI call. A single limit would either
 * throttle browsing pointlessly or leave the expensive endpoints wide open.
 */

import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { ErrorCodes } from '../utils/ApiError.js';

/**
 * Identifies who to count a request against.
 *
 * Prefers the authenticated user id over the IP address. Whole schools sit
 * behind one NAT gateway, so IP-based limiting would have thirty students in a
 * computer lab sharing a single quota.
 *
 * @private
 * @param {import('express').Request} req - The request.
 * @returns {string} A counting key.
 */
function keyForRequest(req) {
  return req.user?.id ?? req.ip;
}

/**
 * Builds a limiter that reports failures in our standard error envelope.
 *
 * @private
 * @param {number} max - Requests allowed per minute.
 * @param {string} message - What to tell the user when they hit the limit.
 * @returns {import('express').RequestHandler}
 */
function build(max, message) {
  return rateLimit({
    windowMs: 60_000,
    max,
    keyGenerator: keyForRequest,
    standardHeaders: true,  // RateLimit-* headers, so a client can self-throttle.
    legacyHeaders: false,
    // Tests would otherwise fail intermittently once a suite exceeds the limit.
    skip: () => env.IS_TEST,
    handler: (req, res) => {
      res.status(429).json({
        ok: false,
        error: { code: ErrorCodes.RATE_LIMITED, message },
        requestId: req.id,
      });
    },
  });
}

/**
 * Limit for ordinary endpoints — listing sessions, fetching subjects.
 *
 * @type {import('express').RequestHandler}
 */
export const generalLimiter = build(
  env.RATE_LIMIT_GENERAL_PER_MIN,
  'You are sending requests too quickly. Wait a moment and try again.',
);

/**
 * Tighter limit for endpoints that call the AI. These cost money per request.
 *
 * @type {import('express').RequestHandler}
 */
export const aiLimiter = build(
  env.RATE_LIMIT_AI_PER_MIN,
  'You have asked a lot of questions in a short time. Give it a minute and try again.',
);
