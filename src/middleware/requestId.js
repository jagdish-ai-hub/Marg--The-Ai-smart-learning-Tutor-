/**
 * @file Gives every request an id, and adds the `res.ok()` response helper.
 *
 * The request id appears in every log line and in every response body. When a
 * student reports "it broke", the id from their response is enough to find the
 * exact request in the logs — no guessing from timestamps.
 */

import { newRequestId } from '../utils/ids.js';

/**
 * Attaches `req.id`, echoes it as the `X-Request-Id` header, and adds
 * `res.ok()` for sending successful responses.
 *
 * `res.ok()` exists so no route has to remember the envelope shape by hand.
 * Every success looks the same because there is only one place that builds one.
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @param {import('express').NextFunction} next - Pass control onward.
 * @returns {void}
 *
 * @example
 * // In a controller:
 * res.ok({ session, steps });
 * // Sends: { "ok": true, "data": { … }, "requestId": "req_…" }
 */
export function requestId(req, res, next) {
  // Respect an id from an upstream proxy so a trace stays continuous.
  req.id = req.get('X-Request-Id') || newRequestId();
  res.set('X-Request-Id', req.id);

  /**
   * Sends a successful JSON response in the standard envelope.
   *
   * @param {object} data - The payload for the `data` field.
   * @param {number} [status=200] - HTTP status code.
   * @returns {import('express').Response}
   */
  res.ok = (data, status = 200) => res.status(status).json({
    ok: true,
    data,
    requestId: req.id,
  });

  next();
}
