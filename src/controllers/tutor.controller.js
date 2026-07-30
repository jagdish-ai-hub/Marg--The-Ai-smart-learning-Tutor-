/**
 * @file The tutoring endpoints — ask, stream, hint, reveal, check, explain.
 *
 * This is where a student actually talks to Marg. Every endpoint here takes an
 * optional `mode` (`guide`, `explain`, `discuss`, `check`) so the frontend can
 * back a button with it; leave it out and Marg works out the mode from the
 * message itself.
 */

import * as sessionService from '../services/sessionService.js';
import * as tutorService from '../services/tutorService.js';
import * as markingService from '../services/markingService.js';
import { SseStream } from '../utils/sse.js';
import { toPublicMessage, toPublicSession, toPublicStep } from '../utils/serialize.js';
import { logger } from '../utils/logger.js';

/**
 * `POST /api/v1/sessions/:id/ask` — send a message, get the whole reply.
 *
 * Auth: required.
 * Body: `{ message, mode? }`
 * Returns: `{ message, mode, refused, revealAvailable, session }`
 * Errors: `SESSION_NOT_FOUND`, `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`
 *
 * `refused: true` means the guardrails redirected. Still a 200 — render
 * `message` as a normal assistant bubble.
 *
 * `revealAvailable: true` means the student asked for the answer and asking
 * once more would unlock it. Show a "show me the answer" button.
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function ask(req, res) {
  const { session, steps } = await sessionService.loadSessionOrThrow(req.params.id, req.user.id);

  const result = await tutorService.ask({
    session,
    steps,
    message: req.body.message,
    requestedMode: req.body.mode,
  });

  // Re-read the session: the reveal gate may have changed its state mid-turn.
  const { session: updated } = await sessionService.loadSessionOrThrow(req.params.id, req.user.id);

  res.ok({
    message: toPublicMessage(result.message),
    mode: result.mode,
    refused: result.refused,
    revealAvailable: result.revealAvailable,
    session: toPublicSession(updated),
  });
}

/**
 * `GET /api/v1/sessions/:id/ask/stream` — the same thing, streamed over SSE.
 *
 * A GET with query parameters so the browser's built-in `EventSource` works
 * with no extra client code. `EventSource` also cannot send headers, which is
 * why the token may be passed as `?token=`.
 *
 * Auth: required — `Authorization` header or `?token=`.
 * Query: `message` (required), `mode?`, `token?`
 * Events: `start`, `delta`, `step`, `done`, `error` — see docs/FRONTEND-GUIDE.md.
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function askStream(req, res) {
  const { session, steps } = await sessionService.loadSessionOrThrow(req.params.id, req.user.id);
  const { message, mode } = req.validatedQuery;

  const stream = new SseStream(req, res);

  try {
    for await (const event of tutorService.askStream({
      session,
      steps,
      message,
      requestedMode: mode,
      // Cancels the upstream AI call the moment the student closes the tab, so
      // we stop paying for tokens nobody will ever read.
      signal: stream.abortSignal,
    })) {
      // Exactly one `start` event per stream, sent once the mode is known —
      // the frontend can rely on it arriving first and never twice.
      if (event.type === 'meta') {
        stream.send('start', {
          sessionId: session.id,
          mode: event.mode,
          refused: event.refused,
        });
      } else if (event.type === 'delta') {
        stream.send('delta', { text: event.text });
      } else if (event.type === 'done') {
        stream.send('done', {
          messageId: event.messageId,
          mode: event.mode,
          refused: event.refused ?? false,
          refusalReason: event.refusalReason ?? null,
          revealAvailable: event.revealAvailable ?? false,
          usage: event.usage ?? null,
        });
      }
    }
  } catch (error) {
    // The student navigated away. Not a failure, and nobody is listening.
    if (stream.abortSignal.aborted) {
      logger.debug('Stream aborted by client', { sessionId: session.id });
    } else {
      logger.error('Streaming failed', { sessionId: session.id, message: error.message });
      // Errors must go down the open stream as an `error` event — the response
      // has already started, so the normal JSON error path is unavailable.
      stream.sendError(
        error.code ?? 'INTERNAL_ERROR',
        error.status >= 500 || !error.status
          ? 'Marg could not finish that reply. Try asking again.'
          : error.message,
      );
    }
  } finally {
    stream.close();
  }
}

/**
 * `POST /api/v1/sessions/:id/hint` — the smallest useful nudge.
 *
 * Does not count against the reveal gate. A hint is not an answer, and asking
 * for one should never be held against a student.
 *
 * Auth: required.
 * Body: `{ stepIndex? }` — defaults to the step they are on.
 * Returns: `{ message }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function hint(req, res) {
  const { session, steps } = await sessionService.loadSessionOrThrow(req.params.id, req.user.id);

  const result = await tutorService.hint({
    session,
    steps,
    stepIndex: req.body.stepIndex,
  });

  res.ok({ message: toPublicMessage(result.message) });
}

/**
 * `POST /api/v1/sessions/:id/reveal` — ask for the final answer.
 *
 * THE FRICTION GATE, AS AN ENDPOINT.
 *   First call  -> `revealed: false`, a hint, and `revealAvailable: true`.
 *                  Show the button again labelled "show me anyway".
 *   Second call -> `revealed: true` and the full worked solution.
 *
 * Under `answerPolicy: 'never'` it always returns `revealed: false` with
 * `revealAvailable: false`, so the frontend can hide the button entirely
 * rather than offering something that cannot happen.
 *
 * Auth: required.
 * Body: none.
 * Returns: `{ message, revealed, revealAvailable, requirement, session }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function reveal(req, res) {
  const { session, steps } = await sessionService.loadSessionOrThrow(req.params.id, req.user.id);

  const result = await tutorService.reveal({ session, steps });
  const { session: updated, steps: updatedSteps } =
    await sessionService.loadSessionOrThrow(req.params.id, req.user.id);

  res.ok({
    message: toPublicMessage(result.message),
    revealed: result.revealed,
    revealAvailable: result.revealAvailable,
    /** Why it is still locked: `ask_again`, `attempt_first`, or `policy_never`. */
    requirement: result.requirement,
    session: toPublicSession(updated),
    steps: updatedSteps.map(toPublicStep),
  });
}

/**
 * `POST /api/v1/sessions/:id/check` — mark the student's working.
 *
 * The "get marked, not just graded" endpoint. The response names the exact step
 * that broke (`marking.firstBrokenStepIndex`) so the UI can circle it, explains
 * why, and gives a nudge that never contains the answer.
 *
 * Auth: required.
 * Body: `{ attempt, stepId? }`
 * Returns: `{ marking, message, steps, session }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function check(req, res) {
  const { session, steps } = await sessionService.loadSessionOrThrow(req.params.id, req.user.id);

  const result = await markingService.checkAttempt({
    session,
    steps,
    userId: req.user.id,
    attempt: req.body.attempt,
    stepId: req.body.stepId,
  });

  const { session: updated } = await sessionService.loadSessionOrThrow(req.params.id, req.user.id);

  res.ok({
    marking: result.marking,
    message: toPublicMessage(result.message),
    steps: result.steps.map(toPublicStep),
    session: toPublicSession(updated),
  });
}

/**
 * `POST /api/v1/sessions/:id/explain` — explain one step in more depth.
 *
 * This is the "wait, why does the sign flip here?" moment from the landing
 * page. Never unlocks the final answer, however the question is phrased.
 *
 * Auth: required.
 * Body: `{ stepId?, question? }`
 * Returns: `{ message, step }`
 * Errors: `STEP_NOT_FOUND`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function explain(req, res) {
  const { session, steps } = await sessionService.loadSessionOrThrow(req.params.id, req.user.id);

  const result = await tutorService.explainStep({
    session,
    steps,
    stepId: req.body.stepId,
    question: req.body.question,
  });

  res.ok({
    message: toPublicMessage(result.message),
    step: toPublicStep(result.step),
  });
}
