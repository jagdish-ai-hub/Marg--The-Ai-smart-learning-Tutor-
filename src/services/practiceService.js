/**
 * @file Practice sets — "give me 5 more like this".
 *
 * Finishing one problem proves very little. Getting three more of the same kind
 * right is what turns a lucky guess into a skill, so this is the natural next
 * step after a session ends.
 *
 * Answers are stored server-side and only returned once the student submits,
 * for the same reason `finalAnswer` is hidden on a session: otherwise the
 * answers arrive in the same response as the questions.
 */

import { store } from '../store/index.js';
import { generateStructured } from '../ai/registry.js';
import {
  PracticeSchema,
  practiceJsonSchema,
  MarkingSchema,
  markingJsonSchema,
} from '../ai/schemas.js';
import { buildPracticePrompt } from '../prompts/tasks.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

/**
 * Generates a practice set targeting a skill the student just worked on.
 *
 * @param {object} options
 * @param {string} options.userId - Who the set is for.
 * @param {object} options.session - The session it follows on from.
 * @param {object[]} options.steps - The session's steps, used to pick the skill.
 * @param {number} [options.count=3] - How many problems, 1 to 10.
 * @param {string} [options.skill] - Override which skill to drill.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<object>} The stored practice set, answers included — the
 *   caller must serialise it with `toPublicPracticeSet` before sending it out.
 */
export async function generatePractice({ userId, session, steps, count = 3, skill, signal }) {
  // Default to the skill the student actually struggled with. Drilling the step
  // they got wrong is far more useful than drilling the first step.
  const brokenStep = steps.find((step) => step.status === 'incorrect');
  const targetSkill = skill
    ?? brokenStep?.skill
    ?? steps.at(-1)?.skill
    ?? session.topic
    ?? 'general practice';

  const generated = await generateStructured({
    schemaName: 'practice',
    jsonSchema: practiceJsonSchema,
    zodSchema: PracticeSchema,
    system: buildPracticePrompt(session.subjectId, targetSkill, count),
    messages: [{
      role: 'user',
      content: `The student just worked on: ${session.restatedProblem}\n\nGenerate ${count} problems drilling "${targetSkill}".`,
    }],
    temperature: 0.8, // Higher: repetitive practice problems would defeat the point.
    // Reasoning headroom — see sessionService.js's step_plan call for the
    // measurements behind this margin.
    maxTokens: 2200,
    signal,
  });

  const set = await store.practiceSets.create({
    userId,
    sessionId: session.id,
    subjectId: session.subjectId,
    skill: generated.skill || targetSkill,
    problems: generated.problems.slice(0, count),
  });

  logger.info('Practice set generated', {
    userId,
    setId: set.id,
    skill: set.skill,
    count: set.problems.length,
  });

  return set;
}

/**
 * Marks a submitted practice set and summarises how it went.
 *
 * @param {object} options
 * @param {string} options.setId - Which set.
 * @param {string} options.userId - Who is submitting.
 * @param {Array<{index: number, answer: string}>} options.answers - The student's answers.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<object>} The updated set, including `results`.
 * @throws {ApiError} `PRACTICE_SET_NOT_FOUND`.
 */
export async function submitPractice({ setId, userId, answers, signal }) {
  const set = await store.practiceSets.findById(setId, userId);
  if (!set) {
    throw ApiError.notFound(ErrorCodes.PRACTICE_SET_NOT_FOUND, 'No practice set with that id.');
  }

  const byIndex = new Map(answers.map((answer) => [answer.index, answer.answer]));

  const comparison = set.problems
    .map((problem, position) => {
      const index = position + 1;
      return [
        `Problem ${index}: ${problem.prompt}`,
        `Correct answer: ${problem.answer}`,
        `Student answered: ${byIndex.get(index) ?? '(left blank)'}`,
      ].join('\n');
    })
    .join('\n\n');

  // Reuse the marking schema: "one verdict per numbered item, plus an error tag
  // and a nudge" is exactly the shape needed here, with problems standing in
  // for steps. Reusing it also means the frontend renders both with one component.
  const marking = await generateStructured({
    schemaName: 'marking',
    jsonSchema: markingJsonSchema,
    zodSchema: MarkingSchema,
    system: `You are marking a set of ${set.subjectId} practice problems on "${set.skill}".

Give one verdict per problem, using the problem number as the index. Judge the
mathematics, not the formatting — "x = -1/2" and "x = -0.5" are the same answer.

Set errorType to the pattern you see across the whole set, if there is one.
The nudge should name the single thing worth practising next.

Reply with JSON only.`,
    messages: [{ role: 'user', content: comparison }],
    temperature: 0.1,
    // Reasoning headroom — see sessionService.js's step_plan call for the
    // measurements behind this margin.
    maxTokens: 1800,
    signal,
  });

  const correctCount = marking.steps.filter((item) => item.verdict === 'correct').length;

  // Log a set-wide mistake pattern, so practice feeds the weakness report too.
  if (marking.errorType && correctCount < set.problems.length) {
    await store.mistakes.record({
      userId,
      sessionId: set.sessionId,
      subjectId: set.subjectId,
      topic: set.skill,
      skill: set.skill,
      errorType: marking.errorType,
      errorSummary: marking.errorSummary,
      stepIndex: null,
    });
  }

  return store.practiceSets.update(setId, {
    submittedAt: new Date().toISOString(),
    results: {
      correctCount,
      total: set.problems.length,
      perProblem: marking.steps,
      errorType: marking.errorType,
      errorSummary: marking.errorSummary,
      nudge: marking.nudge,
    },
  });
}
