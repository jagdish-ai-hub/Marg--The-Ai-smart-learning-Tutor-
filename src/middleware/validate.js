/**
 * @file Checks request bodies and query strings against a Zod schema.
 *
 * Two things this buys you:
 *   1. Routes can trust their input completely. No `if (!req.body.problem)`
 *      scattered through the controllers.
 *   2. The frontend gets a precise error — *which* field, and *what* is wrong —
 *      instead of a generic "bad request" that takes twenty minutes to debug.
 *
 * @example
 * router.post('/sessions',
 *   validateBody(z.object({ subjectId: z.string(), problem: z.string().min(3) })),
 *   controller.create,
 * );
 *
 * // A bad request gets back:
 * // 422 { "ok": false, "error": { "code": "VALIDATION_FAILED",
 * //        "details": { "fields": [{ "path": "problem", "message": "..." }] } } }
 */

import { ApiError } from '../utils/ApiError.js';

/**
 * Turns Zod's error report into a flat list the frontend can render next to
 * the right input box.
 *
 * @private
 * @param {import('zod').ZodError} error - The validation failure.
 * @returns {{fields: Array<{path: string, message: string}>}}
 */
function formatIssues(error) {
  return {
    fields: error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

/**
 * Validates `req.body` and replaces it with the parsed result.
 *
 * Replacing rather than merely checking matters: Zod strips unknown keys and
 * applies defaults, so downstream code sees exactly the fields the schema
 * describes and nothing a caller invented.
 *
 * @param {import('zod').ZodType} schema - The schema to check against.
 * @returns {import('express').RequestHandler}
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      return next(ApiError.validation(
        'Some fields in your request are missing or invalid.',
        formatIssues(result.error),
      ));
    }
    req.body = result.data;
    next();
  };
}

/**
 * Validates `req.query` and stores the parsed result on `req.validatedQuery`.
 *
 * Written to a new property because Express 5 makes `req.query` a getter that
 * cannot be assigned to. Using a separate property works on both Express 4 and
 * 5, so an upgrade will not silently break every paginated endpoint.
 *
 * @param {import('zod').ZodType} schema - The schema to check against.
 * @returns {import('express').RequestHandler}
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      return next(ApiError.validation(
        'Some query parameters are missing or invalid.',
        formatIssues(result.error),
      ));
    }
    req.validatedQuery = result.data;
    next();
  };
}
