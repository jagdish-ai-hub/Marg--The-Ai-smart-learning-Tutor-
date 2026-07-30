/**
 * @file Marking a student's attempt — the "get marked, not just graded" feature.
 *
 * A grader returns right or wrong. Marg returns *which step* went sideways and
 * *why*, which is the difference between "you got it wrong" and "you dropped
 * the negative when you divided". One of those a student can act on.
 *
 * Every mistake found here is also written to the mistake log, which is what
 * lets `insightsService` say "that's the fourth sign error this week" — the
 * thing a human tutor notices and an app usually cannot.
 */

import { store } from '../store/index.js';
import { generateStructured } from '../ai/registry.js';
import { MarkingSchema, markingJsonSchema } from '../ai/schemas.js';
import { buildMarkingPrompt } from '../prompts/tasks.js';
import { logger } from '../utils/logger.js';

/**
 * Marks a student's working, step by step.
 *
 * @param {object} options
 * @param {object} options.session - The session.
 * @param {object[]} options.steps - Its steps.
 * @param {string} options.userId - Who submitted, for the mistake log.
 * @param {string} options.attempt - The student's working, as they wrote it.
 * @param {string} [options.stepId] - Mark only this step, if given.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<{marking: object, message: object, steps: object[]}>}
 *   The marking result, the stored feedback message, and the updated steps
 *   (so the frontend can repaint the progress bar in one go).
 *
 * @example
 * const { marking } = await checkAttempt({ session, steps, userId, attempt: 'x = 1/2 or x = -3' });
 * marking.firstBrokenStepIndex; // 3
 * marking.errorType;            // 'sign_error'
 */
export async function checkAttempt({ session, steps, userId, attempt, stepId, signal }) {
  const targetStep = stepId ? steps.find((step) => step.id === stepId) : null;

  const context = targetStep
    ? `The student is working on step ${targetStep.index}: "${targetStep.instruction}"\n\nTheir attempt:\n${attempt}`
    : `The student's full working:\n${attempt}`;

  const marking = await generateStructured({
    schemaName: 'marking',
    jsonSchema: markingJsonSchema,
    zodSchema: MarkingSchema,
    system: buildMarkingPrompt(session, steps),
    messages: [{ role: 'user', content: context }],
    temperature: 0.1,
    maxTokens: 1200,
    signal,
  });

  await applyVerdictsToSteps(session.id, marking);

  // Move the student to the first step that needs work, or past the end when
  // everything is correct — this is what drives the progress bar.
  const nextIndex = marking.firstBrokenStepIndex ?? steps.length + 1;
  await store.sessions.update(session.id, {
    currentStepIndex: Math.min(nextIndex, steps.length),
    attemptCount: (session.attemptCount ?? 0) + 1,
    ...(marking.overall === 'correct' ? { status: 'completed' } : {}),
  });

  await recordMistake({ session, steps, userId, marking });

  const message = await store.messages.append({
    sessionId: session.id,
    role: 'assistant',
    content: buildFeedbackText(marking),
    mode: 'check',
    meta: {
      refused: false,
      kind: 'marking',
      overall: marking.overall,
      firstBrokenStepIndex: marking.firstBrokenStepIndex,
      errorType: marking.errorType,
    },
  });

  const updatedSteps = await store.steps.listBySession(session.id);

  logger.info('Attempt marked', {
    sessionId: session.id,
    overall: marking.overall,
    errorType: marking.errorType,
  });

  return { marking, message, steps: updatedSteps };
}

/**
 * Writes each step's verdict back onto the stored steps.
 *
 * @private
 * @param {string} sessionId - Which session.
 * @param {object} marking - The marking result.
 * @returns {Promise<void>}
 */
async function applyVerdictsToSteps(sessionId, marking) {
  for (const verdict of marking.steps) {
    const status =
      verdict.verdict === 'correct' ? 'correct'
        : verdict.verdict === 'not_attempted' ? 'pending'
          : 'incorrect';
    await store.steps.setStatus(sessionId, verdict.index, status);
  }

  // The first broken step becomes the active one, so the UI can circle it.
  if (marking.firstBrokenStepIndex) {
    await store.steps.setStatus(sessionId, marking.firstBrokenStepIndex, 'incorrect');
  }
}

/**
 * Records a mistake for the weakness report, tagged with the skill it belongs to.
 *
 * The skill comes from the step that broke rather than from the model, which
 * keeps tags consistent across sessions — "factoring" stays "factoring" and
 * does not drift into "factorising quadratic expressions" next week, so the
 * counts in the weakness report actually add up.
 *
 * @private
 * @param {object} options
 * @param {object} options.session - The session.
 * @param {object[]} options.steps - Its steps.
 * @param {string} options.userId - Whose mistake.
 * @param {object} options.marking - The marking result.
 * @returns {Promise<void>}
 */
async function recordMistake({ session, steps, userId, marking }) {
  if (!marking.errorType || marking.overall === 'correct') return;

  const brokenStep = steps.find((step) => step.index === marking.firstBrokenStepIndex);

  await store.mistakes.record({
    userId,
    sessionId: session.id,
    subjectId: session.subjectId,
    topic: session.topic,
    skill: brokenStep?.skill ?? 'unknown',
    errorType: marking.errorType,
    errorSummary: marking.errorSummary,
    stepIndex: marking.firstBrokenStepIndex,
  });
}

/**
 * Turns a structured marking result into the message shown in the chat.
 *
 * The frontend gets the structured version too and may render its own layout;
 * this text keeps the transcript readable, and matters for context on later
 * turns — the AI reads the transcript, so the feedback has to make sense as prose.
 *
 * @private
 * @param {object} marking - The marking result.
 * @returns {string} Readable feedback.
 */
function buildFeedbackText(marking) {
  if (marking.overall === 'correct') {
    return `That's right.\n\n${marking.nudge}`;
  }

  const parts = [];

  const correctSteps = marking.steps.filter((step) => step.verdict === 'correct');
  if (correctSteps.length > 0) {
    // Always lead with what worked. Starting on the error makes a student read
    // the whole thing defensively, and they stop taking in the correction.
    parts.push(correctSteps.map((step) => `Step ${step.index}: ${step.comment}`).join('\n'));
  }

  const broken = marking.steps.find((step) => step.index === marking.firstBrokenStepIndex);
  if (broken) {
    parts.push(`Step ${broken.index} is where it went sideways — ${broken.comment}`);
  }

  if (marking.errorSummary) parts.push(marking.errorSummary);
  parts.push(marking.nudge);

  return parts.join('\n\n');
}
