/**
 * @file The single place every error becomes a JSON response.
 *
 * Two rules keep this safe and predictable:
 *
 *   1. An `ApiError` is something we chose to reject, so its message is written
 *      for a user and is safe to show.
 *   2. Anything else is a bug we did not anticipate. Its message could contain
 *      a file path, a query, or part of an API key, so it is logged in full and
 *      reported to the client as a generic 500.
 *
 * Getting rule 2 backwards is how internal details end up in a screenshot on
 * social media.
 */

import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Express error middleware. Must be registered last, after all routes.
 *
 * The unused `next` parameter is required: Express identifies error middleware
 * by its arity, and removing it turns this into an ordinary handler that never
 * runs.
 *
 * @param {Error} error - Whatever was thrown or passed to `next()`.
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @param {import('express').NextFunction} next - Unused, but required.
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, next) {
  // The client hung up mid-stream. Nothing to report, and nobody to report to.
  if (error?.name === 'AbortError' || req.aborted) {
    logger.debug('Request aborted by client', { requestId: req.id });
    return;
  }

  // Headers already sent means we were streaming. We cannot switch to a JSON
  // error now, so just end the response cleanly.
  if (res.headersSent) {
    logger.error('Error after response started', { requestId: req.id, message: error.message });
    return res.end();
  }

  if (error instanceof ApiError) {
    // 5xx from a provider is worth investigating; a 404 is routine.
    const level = error.status >= 500 ? 'error' : 'warn';
    logger[level]('Request failed', {
      requestId: req.id,
      code: error.code,
      status: error.status,
      path: req.path,
      ...(error.details ? { details: error.details } : {}),
    });

    return res.status(error.status).json({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      requestId: req.id,
    });
  }

  // Multer's own error for an oversized upload. Translated here so the client
  // sees one of our codes rather than a library-specific string.
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      ok: false,
      error: {
        code: ErrorCodes.UPLOAD_REJECTED,
        message: `That image is too large. The limit is ${env.MAX_UPLOAD_MB} MB.`,
      },
      requestId: req.id,
    });
  }

  // Malformed JSON in the body — a very common frontend mistake, and worth a
  // clear message rather than a generic 500.
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({
      ok: false,
      error: {
        code: ErrorCodes.VALIDATION_FAILED,
        message: 'The request body is not valid JSON.',
      },
      requestId: req.id,
    });
  }

  logger.error('Unhandled error', {
    requestId: req.id,
    path: req.path,
    message: error?.message,
    stack: error?.stack,
  });

  res.status(500).json({
    ok: false,
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Something went wrong on our side. Please try again.',
      // The stack is a development convenience only. In production it would be
      // a gift to anyone probing the API.
      ...(env.IS_PRODUCTION ? {} : { details: { message: error?.message, stack: error?.stack } }),
    },
    requestId: req.id,
  });
}
