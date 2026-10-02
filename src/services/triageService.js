/**
 * @file Runs the one cheap AI call that sizes up each incoming message.
 *
 * Before Marg spends a real teaching call on a message, it asks a small, fast
 * model two questions at once: *should we help with this?* and *what kind of
 * help is wanted?* Combining them into a single request rather than two halves
 * both the latency and the cost, and neither answer is useful without the other.
 *
 * The result feeds `guardService` (which decides whether to proceed) and
 * `intentService` (which decides the mode).
 */

import { generateStructured } from '../ai/registry.js';
import { TriageSchema, triageJsonSchema } from '../ai/schemas.js';
import { buildTriagePrompt } from '../prompts/tasks.js';
import { logger } from '../utils/logger.js';

/**
 * A conservative result used when the triage call itself fails.
 *
 * Note the direction of the failure: if we cannot classify a message, we let it
 * through as a normal academic question rather than blocking it. A student
 * wrongly refused help is a much worse outcome than an off-topic message
 * slipping past — and the system prompt still holds the line on the second one.
 *
 * @private
 * @type {object}
 */
const PERMISSIVE_FALLBACK = {
  inScope: true,
  category: 'academic',
  subjectId: null,
  integrityRisk: 'none',
  mode: 'guide',
  wantsAnswer: false,
  reason: 'triage unavailable, defaulted to allowing the request',
};

/**
 * Classifies a student's message.
 *
 * @param {object} options
 * @param {string} options.message - What the student wrote.
 * @param {object} [options.session] - The session, when the message is inside one.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<object>} A value matching `TriageSchema`. Never throws.
 *
 * @example
 * const triage = await triageMessage({ message: 'why does the sign flip here?' });
 * triage.mode;      // 'explain'
 * triage.inScope;   // true
 */
export async function triageMessage({ message, session, signal }) {
  // Inside an established session we already know the subject, so tell the
  // classifier — it stops "and what about part b?" being read as off-topic
  // just because the follow-up has no visible subject matter of its own.
  const context = session
    ? `The student is in a ${session.subjectId} session about "${session.topic ?? session.title}". Their message:\n\n${message}`
    : message;

  try {
    const result = await generateStructured({
      schemaName: 'triage',
      jsonSchema: triageJsonSchema,
      zodSchema: TriageSchema,
      system: buildTriagePrompt(),
      messages: [{ role: 'user', content: context }],
      // Classification should be repeatable, so temperature is as low as it goes.
      temperature: 0,
      // Reasoning models (DeepSeek's flash tier, among others) spend part of
      // this budget on an internal reasoning pass before ever emitting the
      // final JSON — measured at ~140-180 reasoning tokens alone for this
      // prompt, with real variance between calls even at temperature 0. 300
      // was too tight a margin and occasionally got cut off mid-answer,
      // producing an empty response. 600 leaves real headroom while staying
      // cheap — this is still the "fast" tier, not the main teaching call.
      maxTokens: 600,
      tier: 'fast',
      signal,
    });

    // A message arriving inside a session inherits that session's subject when
    // the classifier could not name one itself.
    if (!result.subjectId && session?.subjectId) {
      result.subjectId = session.subjectId;
    }

    return result;
  } catch (error) {
    if (signal?.aborted) throw error;

    logger.warn('Triage call failed, allowing the request through', { reason: error.message });
    return {
      ...PERMISSIVE_FALLBACK,
      subjectId: session?.subjectId ?? null,
    };
  }
}
