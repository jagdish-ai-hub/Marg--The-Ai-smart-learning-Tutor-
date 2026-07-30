/**
 * @file Handles requests that matched no route.
 *
 * Registered after every route but before the error handler, so an unknown path
 * produces the same JSON envelope as any other failure rather than Express's
 * default HTML page — which would break a frontend that always calls
 * `response.json()`.
 */

import { ApiError, ErrorCodes } from '../utils/ApiError.js';

/**
 * Converts an unmatched request into a `NOT_FOUND` error.
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @param {import('express').NextFunction} next - Passes the error onward.
 * @returns {void}
 */
export function notFound(req, res, next) {
  next(ApiError.notFound(
    ErrorCodes.NOT_FOUND,
    `No route for ${req.method} ${req.path}. See docs/API.md for the endpoint list.`,
  ));
}
