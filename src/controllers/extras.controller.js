/**
 * @file Practice sets, concept explanations, insights, and photo transcription.
 *
 * The four features beyond single-problem tutoring. They share this file
 * because each is only one or two endpoints, and splitting them into four
 * near-empty modules would be more filing than code.
 */

import * as sessionService from '../services/sessionService.js';
import * as practiceService from '../services/practiceService.js';
import * as conceptService from '../services/conceptService.js';
import * as insightsService from '../services/insightsService.js';
import * as visionService from '../services/visionService.js';
import { toPublicPracticeSet } from '../utils/serialize.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';

/**
 * `POST /api/v1/sessions/:id/practice` — "give me 5 more like this".
 *
 * Defaults to drilling the skill from the step the student got *wrong*, which
 * is more useful than drilling the first step. Answers are withheld until the
 * set is submitted.
 *
 * Auth: required.
 * Body: `{ count?, skill? }`
 * Returns: `{ practiceSet }` — problems only, no answers.
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function generatePractice(req, res) {
  const { session, steps } = await sessionService.loadSessionOrThrow(req.params.id, req.user.id);

  const set = await practiceService.generatePractice({
    userId: req.user.id,
    session,
    steps,
    count: req.body.count,
    skill: req.body.skill,
  });

  res.ok({ practiceSet: toPublicPracticeSet(set) }, 201);
}

/**
 * `POST /api/v1/practice/:setId/submit` — mark a completed practice set.
 *
 * Auth: required.
 * Body: `{ answers: [{ index, answer }] }`
 * Returns: `{ practiceSet }` — now including the correct answers and results.
 * Errors: `PRACTICE_SET_NOT_FOUND`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function submitPractice(req, res) {
  const set = await practiceService.submitPractice({
    setId: req.params.setId,
    userId: req.user.id,
    answers: req.body.answers,
  });

  // Answers are safe to include now: the student has committed to theirs.
  res.ok({ practiceSet: toPublicPracticeSet(set, { includeAnswers: true }) });
}

/**
 * `POST /api/v1/concepts/explain` — explain a concept with no problem attached.
 *
 * For "what actually *is* an eigenvalue?" — a real question that should not
 * require inventing a homework problem first.
 *
 * Auth: required.
 * Body: `{ subjectId, concept, depth? }` — depth is `quick`, `standard`, or `deep`.
 * Returns: `{ explanation, refused }`
 * Errors: `SUBJECT_NOT_FOUND`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function explainConcept(req, res) {
  const result = await conceptService.explainConcept({
    subjectId: req.body.subjectId,
    concept: req.body.concept,
    depth: req.body.depth,
  });

  res.ok(result);
}

/**
 * `GET /api/v1/insights/weaknesses` — recurring mistake patterns.
 *
 * The thing a human tutor does that a grading app does not: remembering last
 * week. Each pattern carries a ready-to-render `summary` string, e.g.
 * *"Sign errors came up 4 times, mostly in factoring."*
 *
 * An empty `patterns` array is normal for a new user — show an encouraging
 * empty state, not an error.
 *
 * Auth: required.
 * Query: `days` (1-365, default 30), `limit` (1-20, default 5)
 * Returns: `{ windowDays, totalMistakes, patterns }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function weaknesses(req, res) {
  const { days, limit } = req.validatedQuery;
  res.ok(await insightsService.getWeaknesses({ userId: req.user.id, days, limit }));
}

/**
 * `GET /api/v1/insights/activity` — how much the student has been working.
 *
 * Auth: required.
 * Query: `days` (1-365, default 30)
 * Returns: `{ windowDays, totalSessions, sessionsInWindow, completedInWindow, stepsCompleted, bySubject }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function activity(req, res) {
  const { days } = req.validatedQuery;
  res.ok(await insightsService.getActivity({ userId: req.user.id, days }));
}

/**
 * `POST /api/v1/vision/transcribe` — read a photo of a page.
 *
 * Send as `multipart/form-data` with the image in a field named `image`.
 * Returns **every** problem found on the page, so the student picks one rather
 * than taking a separate photo per question.
 *
 * This does not create a session. Show the student what was read, let them fix
 * any transcription errors, then call `POST /sessions` with the corrected text.
 *
 * Auth: required.
 * Body: `multipart/form-data` with an `image` file.
 * Returns: `{ subjectId, problems, studentWorking }`
 * Errors: `UPLOAD_REJECTED`, `VISION_UNSUPPORTED`
 *
 * @param {import('express').Request} req - The request, with `req.file` from multer.
 * @param {import('express').Response} res - The response.
 * @returns {Promise<void>}
 */
export async function transcribe(req, res) {
  if (!req.file) {
    throw ApiError.badRequest(
      ErrorCodes.UPLOAD_REJECTED,
      'No image was uploaded. Send multipart/form-data with a field named "image".',
    );
  }

  const result = await visionService.transcribeImage({
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
  });

  res.ok(result);
}
