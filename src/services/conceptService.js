/**
 * @file Explaining a concept with no problem attached.
 *
 * Not every question comes with homework. "What actually *is* an eigenvalue?"
 * is a real question a student needs answered, and forcing them to invent a
 * problem first just to ask it would be silly.
 *
 * This is the `discuss` mode as a standalone endpoint. It still passes through
 * the guardrails — a concept explainer is exactly the sort of endpoint that
 * quietly turns into a general chatbot if nobody is watching it.
 */

import { generateText } from '../ai/registry.js';
import { buildTutorSystemPrompt } from '../prompts/tutorSystem.js';
import { findSubject } from '../data/subjects.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { triageMessage } from './triageService.js';
import * as guardService from './guardService.js';

/**
 * How much detail to go into.
 *
 * @private
 * @type {Record<string, string>}
 */
const DEPTH_INSTRUCTIONS = {
  quick: `Keep this SHORT — three or four sentences. Give the student the one
sentence they could repeat back to a friend, then a single concrete example.
No history, no edge cases.`,

  standard: `Explain properly but stay tight — around 150-250 words.
Build the intuition first, then state the formal version, then give one worked
example small enough to follow in your head.`,

  deep: `Go deeper — around 400-600 words.
Start with the intuition, then the formal definition, then a worked example,
then the two mistakes students most often make with this. Finish with what it
connects to next, so they know where this is heading.`,
};

/**
 * Explains a concept.
 *
 * @param {object} options
 * @param {string} options.subjectId - Which subject the concept belongs to.
 * @param {string} options.concept - What to explain, e.g. `'eigenvalues'`.
 * @param {string} [options.depth='standard'] - `quick`, `standard`, or `deep`.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<{explanation: string, refused: boolean, refusalReason?: string}>}
 * @throws {ApiError} `SUBJECT_NOT_FOUND` for an unknown subject.
 *
 * @example
 * const { explanation } = await explainConcept({
 *   subjectId: 'mathematics', concept: 'eigenvalues', depth: 'quick',
 * });
 */
export async function explainConcept({ subjectId, concept, depth = 'standard', signal }) {
  const subject = findSubject(subjectId);
  if (!subject) {
    throw ApiError.notFound(
      ErrorCodes.SUBJECT_NOT_FOUND,
      `"${subjectId}" is not a subject we support. Call GET /api/v1/subjects for the list.`,
    );
  }

  const triage = await triageMessage({ message: `Explain ${concept}`, signal });
  // The caller named the subject, so trust that over the classifier's guess.
  triage.subjectId = triage.subjectId ?? subjectId;
  const decision = guardService.evaluate(triage);

  if (!decision.allowed) {
    return {
      explanation: decision.reply,
      refused: true,
      refusalReason: decision.refusalReason,
    };
  }

  const system = buildTutorSystemPrompt({
    mode: 'discuss',
    answerPolicy: 'on_request',
    // There is no problem being solved here, so there is no answer to protect.
    answerUnlocked: true,
    extra: `You are explaining a ${subject.label} concept with no specific problem attached.\n\n${DEPTH_INSTRUCTIONS[depth] ?? DEPTH_INSTRUCTIONS.standard}`,
  });

  const reply = await generateText({
    system,
    messages: [{ role: 'user', content: `Explain: ${concept}` }],
    temperature: 0.5,
    maxTokens: depth === 'deep' ? 1400 : depth === 'quick' ? 350 : 800,
    signal,
  });

  return { explanation: reply.text, refused: false };
}
