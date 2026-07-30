/**
 * @file Session endpoints — create, list, read, rename, delete.
 *
 * A session is one problem the student is working through. Creating one is the
 * heaviest call in the API: it runs the guardrails and then asks the AI to
 * break the problem into steps, so expect a few seconds.
 */

import * as sessionService from '../services/sessionService.js';
import { toPublicSession, toPublicStep, toPublicMessage } from '../utils/serialize.js';

/**
 * `POST /api/v1/sessions` — starts a session and returns the step plan.
 *
 * Auth: required.
 * Body: `{ subjectId, problem, answerPolicy? }`
 * Returns: `{ session, steps, refused }`
 *
 * If the guardrails decline (off topic, or "write my assignment"), this still
 * returns **200** with `refused: true`, `session: null`, and a `message` to
 * render as a normal chat bubble. It is not an error — see docs/TUTORING-MODEL.md.
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function create(req, res) {
  const { subjectId, problem, answerPolicy } = req.body;

  const result = await sessionService.createSession({
    userId: req.user.id,
    subjectId,
    problem,
    answerPolicy,
  });

  if (result.refused) {
    return res.ok({
      refused: true,
      refusalReason: result.refusalReason,
      session: null,
      steps: [],
      message: result.message,
    });
  }

  res.ok({
    refused: false,
    session: toPublicSession(result.session),
    steps: result.steps.map(toPublicStep),
  }, 201);
}

/**
 * `GET /api/v1/sessions` — lists the user's sessions, newest first.
 *
 * Auth: required.
 * Query: `limit` (1-100, default 20), `offset` (default 0)
 * Returns: `{ sessions, total, limit, offset }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function list(req, res) {
  const { limit, offset } = req.validatedQuery;
  const { items, total } = await sessionService.listSessions(req.user.id, { limit, offset });

  res.ok({
    sessions: items.map(toPublicSession),
    total,
    limit,
    offset,
  });
}

/**
 * `GET /api/v1/sessions/:id` — one session with its steps and full transcript.
 *
 * This is what you call when reopening a session from the list — it returns
 * everything needed to rebuild the screen in one request.
 *
 * Auth: required.
 * Returns: `{ session, steps, messages }`
 * Errors: `SESSION_NOT_FOUND`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function get(req, res) {
  const { session, steps, messages } = await sessionService.getSession(req.params.id, req.user.id);

  res.ok({
    session: toPublicSession(session),
    steps: steps.map(toPublicStep),
    messages: messages.map(toPublicMessage),
  });
}

/**
 * `PATCH /api/v1/sessions/:id` — renames a session.
 *
 * Auth: required.
 * Body: `{ title }`
 * Returns: `{ session }`
 * Errors: `SESSION_NOT_FOUND`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function rename(req, res) {
  const session = await sessionService.renameSession(req.params.id, req.user.id, req.body.title);
  res.ok({ session: toPublicSession(session) });
}

/**
 * `DELETE /api/v1/sessions/:id` — deletes a session and its transcript.
 *
 * Auth: required.
 * Returns: `{ deleted: true }`
 * Errors: `SESSION_NOT_FOUND`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function remove(req, res) {
  await sessionService.deleteSession(req.params.id, req.user.id);
  res.ok({ deleted: true });
}
