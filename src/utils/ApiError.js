/**
 * @file A single error type for everything the API can reject, plus the list of
 * machine-readable error codes.
 *
 * WHY THIS EXISTS
 * The frontend should never have to check `error.message === 'Session not found'`.
 * Message text changes; codes do not. Every failure carries a stable `code`
 * string that the frontend can branch on safely.
 *
 * @example
 * // In a service:
 * if (!session) throw ApiError.notFound('SESSION_NOT_FOUND', 'No session with that id.');
 *
 * // The error middleware turns that into:
 * // HTTP 404
 * // { "ok": false, "error": { "code": "SESSION_NOT_FOUND", "message": "..." } }
 */

/**
 * Every error code this API can return. Keep this list in sync with the table
 * in docs/API.md — the frontend relies on it.
 *
 * @readonly
 * @enum {string}
 */
export const ErrorCodes = {
  /** No token was sent, or the token is invalid/expired. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Valid token, but this user does not own the thing they asked for. */
  FORBIDDEN: 'FORBIDDEN',
  /** The request body or query string did not match what the endpoint expects. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** The route does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** No session with that id belongs to this user. */
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  /** No step with that id inside this session. */
  STEP_NOT_FOUND: 'STEP_NOT_FOUND',
  /** No practice set with that id belongs to this user. */
  PRACTICE_SET_NOT_FOUND: 'PRACTICE_SET_NOT_FOUND',
  /** Unknown subject id. Call GET /subjects for the valid list. */
  SUBJECT_NOT_FOUND: 'SUBJECT_NOT_FOUND',
  /** Too many requests. Check the `Retry-After` header. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** The uploaded file was too big or not an image. */
  UPLOAD_REJECTED: 'UPLOAD_REJECTED',
  /** The AI service is down, out of quota, or returned an error. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** The AI service took longer than AI_TIMEOUT_MS to respond. */
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  /** The AI replied, but not in the structured shape we asked for. */
  PROVIDER_BAD_RESPONSE: 'PROVIDER_BAD_RESPONSE',
  /** The selected provider cannot handle images. */
  VISION_UNSUPPORTED: 'VISION_UNSUPPORTED',
  /** Something unexpected broke on our side. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

/**
 * An error that carries an HTTP status and a stable machine-readable code.
 *
 * Throw this from anywhere; `errorHandler` middleware catches it and formats
 * the response. Anything that is *not* an ApiError is treated as an unexpected
 * bug and reported as a generic 500, so internal details never leak.
 *
 * @extends Error
 */
export class ApiError extends Error {
  /**
   * @param {number} status - HTTP status code, e.g. `404`.
   * @param {string} code - A value from {@link ErrorCodes}.
   * @param {string} message - Human-readable explanation. Safe to show a user.
   * @param {object} [details] - Extra structured context, e.g. which fields failed.
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    // Keeps this constructor out of the stack trace, so the trace points at the
    // line that actually threw.
    Error.captureStackTrace?.(this, ApiError);
  }

  /**
   * 400 — the request was malformed in a way validation did not catch.
   *
   * @param {string} code - A value from {@link ErrorCodes}.
   * @param {string} message - What went wrong.
   * @param {object} [details] - Extra context.
   * @returns {ApiError}
   */
  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }

  /**
   * 401 — the caller is not logged in. The frontend should call
   * `POST /auth/guest` and retry.
   *
   * @param {string} [message] - Override the default message.
   * @returns {ApiError}
   */
  static unauthenticated(message = 'You need a token to do that. Call POST /api/v1/auth/guest first.') {
    return new ApiError(401, ErrorCodes.UNAUTHENTICATED, message);
  }

  /**
   * 403 — logged in, but not allowed to touch this resource.
   *
   * @param {string} [message] - Override the default message.
   * @returns {ApiError}
   */
  static forbidden(message = 'That does not belong to you.') {
    return new ApiError(403, ErrorCodes.FORBIDDEN, message);
  }

  /**
   * 404 — the thing does not exist (or belongs to someone else; we do not
   * distinguish, because saying "exists but not yours" leaks information).
   *
   * @param {string} code - A value from {@link ErrorCodes}.
   * @param {string} message - What was not found.
   * @returns {ApiError}
   */
  static notFound(code, message) {
    return new ApiError(404, code, message);
  }

  /**
   * 422 — the request was well-formed JSON but the values are wrong
   * (missing field, wrong type, too long).
   *
   * @param {string} message - Summary of the problem.
   * @param {object} [details] - Usually `{ fields: [{ path, message }] }`.
   * @returns {ApiError}
   */
  static validation(message, details) {
    return new ApiError(422, ErrorCodes.VALIDATION_FAILED, message, details);
  }

  /**
   * 502 — the upstream AI provider failed us.
   *
   * @param {string} code - Usually `PROVIDER_UNAVAILABLE` or `PROVIDER_BAD_RESPONSE`.
   * @param {string} message - What the provider did.
   * @param {object} [details] - Extra context, e.g. `{ provider: 'gemini', status: 429 }`.
   * @returns {ApiError}
   */
  static provider(code, message, details) {
    return new ApiError(502, code, message, details);
  }

  /**
   * 504 — the AI provider did not answer in time.
   *
   * @param {string} message - What timed out.
   * @param {object} [details] - Extra context.
   * @returns {ApiError}
   */
  static timeout(message, details) {
    return new ApiError(504, ErrorCodes.PROVIDER_TIMEOUT, message, details);
  }

  /**
   * 500 — an unexpected internal failure.
   *
   * @param {string} [message] - Override the default message.
   * @returns {ApiError}
   */
  static internal(message = 'Something went wrong on our side.') {
    return new ApiError(500, ErrorCodes.INTERNAL_ERROR, message);
  }
}
