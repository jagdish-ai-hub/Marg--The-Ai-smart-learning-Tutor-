/**
 * @file Creating and managing tutoring sessions.
 *
 * A session is one problem a student is working through. It owns the numbered
 * step card, the conversation transcript, and the state that decides whether
 * the final answer has been unlocked yet.
 */

import { store } from '../store/index.js';
import { generateStructured } from '../ai/registry.js';
import { StepPlanSchema, stepPlanJsonSchema } from '../ai/schemas.js';
import { buildStepPlanPrompt } from '../prompts/tasks.js';
import { findSubject } from '../data/subjects.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { triageMessage } from './triageService.js';
import * as guardService from './guardService.js';

/**
 * Loads a session and its steps, or throws if it is missing or not this user's.
 *
 * Almost every tutor endpoint starts by calling this, which is why it lives
 * here rather than being repeated in each controller.
 *
 * @param {string} sessionId - Which session.
 * @param {string} userId - Who is asking.
 * @returns {Promise<{session: object, steps: object[]}>}
 * @throws {ApiError} `SESSION_NOT_FOUND` if it does not exist or belongs to someone else.
 */
export async function loadSessionOrThrow(sessionId, userId) {
  const session = await store.sessions.findById(sessionId, userId);
  if (!session) {
    throw ApiError.notFound(ErrorCodes.SESSION_NOT_FOUND, 'No session with that id.');
  }
  const steps = await store.steps.listBySession(sessionId);
  return { session, steps };
}

/**
 * Starts a new session: checks the request is something Marg should help with,
 * asks the AI to break the problem into steps, and stores everything.
 *
 * The guardrails run *before* the expensive planning call, so an off-topic
 * request costs one tiny classification and nothing more.
 *
 * @param {object} options
 * @param {string} options.userId - Who is starting the session.
 * @param {string} options.subjectId - A subject id from `GET /subjects`.
 * @param {string} options.problem - The problem, in the student's own words.
 * @param {string} [options.answerPolicy] - Overrides `DEFAULT_ANSWER_POLICY`.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<{session: object, steps: object[], refused?: boolean, message?: object}>}
 *   The created session and its steps. If the guardrails declined, `refused` is
 *   true, `session` is null, and `message` holds what to show the student.
 * @throws {ApiError} `SUBJECT_NOT_FOUND` for an unknown subject.
 */
export async function createSession({ userId, subjectId, problem, answerPolicy, signal }) {
  const subject = findSubject(subjectId);
  if (!subject) {
    throw ApiError.notFound(
      ErrorCodes.SUBJECT_NOT_FOUND,
      `"${subjectId}" is not a subject we support. Call GET /api/v1/subjects for the list.`,
    );
  }

  const triage = await triageMessage({ message: problem, signal });

  // The student picked the subject on the tile, so we already know it — no
  // reason to depend on the classifier guessing it. This is what lets a
  // refusal offer the right kind of help ("tell me what the program needs to
  // do") instead of a generic one.
  triage.subjectId = triage.subjectId ?? subjectId;

  const decision = guardService.evaluate(triage);

  if (!decision.allowed) {
    logger.info('Session creation declined by guardrails', {
      userId,
      refusalReason: decision.refusalReason,
      triageReason: triage.reason,
    });
    return {
      refused: true,
      refusalReason: decision.refusalReason,
      session: null,
      steps: [],
      message: { role: 'assistant', content: decision.reply, meta: { refused: true } },
    };
  }

  const plan = await generateStructured({
    schemaName: 'step_plan',
    jsonSchema: stepPlanJsonSchema,
    zodSchema: StepPlanSchema,
    system: buildStepPlanPrompt(subjectId),
    messages: [{ role: 'user', content: problem }],
    temperature: 0.2,
    // Reasoning models (see triageService.js) can spend several hundred tokens
    // on an internal reasoning pass before the JSON itself — measured up to
    // ~380 reasoning tokens for a moderate step plan, with real variance
    // between calls. 1200 occasionally got cut off empty; 2500 leaves safe
    // headroom against worst-case variance without materially changing cost
    // for providers that don't reason (they simply stop early).
    maxTokens: 2500,
    signal,
  });

  const session = await store.sessions.create({
    userId,
    subjectId,
    title: plan.title,
    topic: plan.topic,
    problem,
    restatedProblem: plan.restatedProblem,
    // Stored, never serialised to the client. See utils/serialize.js — this is
    // the field the whole reveal gate exists to protect.
    finalAnswer: plan.finalAnswer,
    answerPolicy: answerPolicy ?? env.DEFAULT_ANSWER_POLICY,
    answerRevealed: false,
    mode: 'guide',
  });

  const steps = await store.steps.replaceAll(session.id, plan.steps);

  // Seed the transcript with the student's problem so later AI calls have the
  // original wording, not just our cleaned-up restatement.
  await store.messages.append({
    sessionId: session.id,
    role: 'user',
    content: problem,
    mode: 'guide',
  });

  logger.info('Session created', { userId, sessionId: session.id, subjectId, steps: steps.length });

  return { session, steps, refused: false };
}

/**
 * Lists a user's sessions, newest first.
 *
 * @param {string} userId - Whose sessions.
 * @param {object} [options]
 * @param {number} [options.limit=20] - Page size.
 * @param {number} [options.offset=0] - How many to skip.
 * @returns {Promise<{items: object[], total: number}>}
 */
export async function listSessions(userId, options) {
  return store.sessions.listByUser(userId, options);
}

/**
 * Loads one session with its steps and full transcript.
 *
 * @param {string} sessionId - Which session.
 * @param {string} userId - Who is asking.
 * @returns {Promise<{session: object, steps: object[], messages: object[]}>}
 * @throws {ApiError} `SESSION_NOT_FOUND`.
 */
export async function getSession(sessionId, userId) {
  const { session, steps } = await loadSessionOrThrow(sessionId, userId);
  const messages = await store.messages.listBySession(sessionId);
  return { session, steps, messages };
}

/**
 * Renames a session.
 *
 * @param {string} sessionId - Which session.
 * @param {string} userId - Who is asking.
 * @param {string} title - The new title.
 * @returns {Promise<object>} The updated session.
 * @throws {ApiError} `SESSION_NOT_FOUND`.
 */
export async function renameSession(sessionId, userId, title) {
  await loadSessionOrThrow(sessionId, userId);
  return store.sessions.update(sessionId, { title });
}

/**
 * Deletes a session and everything attached to it.
 *
 * @param {string} sessionId - Which session.
 * @param {string} userId - Who is asking.
 * @returns {Promise<void>}
 * @throws {ApiError} `SESSION_NOT_FOUND`.
 */
export async function deleteSession(sessionId, userId) {
  await loadSessionOrThrow(sessionId, userId);
  await store.sessions.remove(sessionId);
  logger.info('Session deleted', { userId, sessionId });
}

/**
 * Builds the recent transcript in the shape the AI expects.
 *
 * Only the last few turns are sent. Older context is rarely relevant to the
 * current step, and sending the whole history would grow the cost of every
 * message in a long session without improving the teaching.
 *
 * @param {string} sessionId - Which session.
 * @param {number} [limit=10] - How many recent messages to include.
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function buildConversationHistory(sessionId, limit = 10) {
  const messages = await store.messages.listBySession(sessionId, { limit });
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content,
  }));
}
