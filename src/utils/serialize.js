/**
 * @file Converts stored records into the exact shape sent to the browser.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * A session record holds `finalAnswer`, and a practice problem holds `answer`.
 * If either is ever included in a response, a student can open the network tab
 * and read the answer without doing a single step — quietly defeating the whole
 * product, with no error message to warn anyone it happened.
 *
 * So responses are built by *listing the fields to include*, never by deleting
 * fields from the record. With an allow-list, a new secret field added to the
 * store is private by default. With a deny-list, it would leak until someone
 * remembered to add it — and nobody ever remembers.
 */

/**
 * Prepares a session for the client.
 *
 * @param {object} session - A stored session record.
 * @returns {object} Safe public fields only — never `finalAnswer`.
 *
 * @example
 * toPublicSession(session).finalAnswer; // always undefined
 */
export function toPublicSession(session) {
  return {
    id: session.id,
    subjectId: session.subjectId,
    title: session.title,
    topic: session.topic,
    problem: session.problem,
    restatedProblem: session.restatedProblem,
    status: session.status,
    mode: session.mode,
    answerPolicy: session.answerPolicy,
    currentStepIndex: session.currentStepIndex,
    /** How many times the student has asked for the answer. Drives the reveal gate. */
    revealCount: session.revealCount,
    /** True once the full answer has been handed over. */
    answerRevealed: Boolean(session.answerRevealed),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/**
 * Prepares a step for the client.
 *
 * @param {object} step - A stored step record.
 * @returns {object} Public step fields.
 */
export function toPublicStep(step) {
  return {
    id: step.id,
    index: step.index,
    instruction: step.instruction,
    skill: step.skill,
    /** `pending` | `active` | `correct` | `incorrect` | `revealed` — drives the progress bar. */
    status: step.status,
  };
}

/**
 * Prepares a transcript message for the client.
 *
 * @param {object} message - A stored message record.
 * @returns {object} Public message fields.
 */
export function toPublicMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    mode: message.mode ?? null,
    meta: message.meta ?? {},
    createdAt: message.createdAt,
  };
}

/**
 * Prepares a practice set for the client, hiding every answer.
 *
 * @param {object} set - A stored practice set.
 * @param {object} [options]
 * @param {boolean} [options.includeAnswers=false] - Set true only *after* the
 *   student has submitted, when showing them how they did.
 * @returns {object} Public practice-set fields.
 */
export function toPublicPracticeSet(set, { includeAnswers = false } = {}) {
  return {
    id: set.id,
    skill: set.skill,
    subjectId: set.subjectId,
    sessionId: set.sessionId ?? null,
    submittedAt: set.submittedAt ?? null,
    problems: set.problems.map((problem, position) => ({
      index: position + 1,
      prompt: problem.prompt,
      difficulty: problem.difficulty,
      ...(includeAnswers ? { answer: problem.answer } : {}),
    })),
    ...(set.results ? { results: set.results } : {}),
  };
}
