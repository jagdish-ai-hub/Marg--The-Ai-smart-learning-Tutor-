/**
 * @file Every route in the API, in one file.
 *
 * Kept together deliberately. With around twenty endpoints, one readable list
 * beats eight files you have to open in turn to answer "what does this API
 * actually expose?". Each route reads as a sentence: path, who may call it,
 * what shape the input takes, and which controller handles it.
 *
 * Reading order for each line:
 *   router.post('/path', rateLimit, auth, validation, controller)
 */

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { generalLimiter, aiLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { env } from '../config/env.js';
import { allSubjectIds } from '../data/subjects.js';
import { MODES } from '../services/intentService.js';

import * as authController from '../controllers/auth.controller.js';
import * as metaController from '../controllers/meta.controller.js';
import * as sessionsController from '../controllers/sessions.controller.js';
import * as tutorController from '../controllers/tutor.controller.js';
import * as extrasController from '../controllers/extras.controller.js';

/**
 * Photo uploads are held in memory and passed straight to the AI provider —
 * never written to disk. Nothing needs the file after the request ends, and not
 * writing it means no temp files to clean up and no images left on the server.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

// --- Reusable validation pieces ---------------------------------------------

/** Subject ids are checked against the real list, so a typo fails at the edge. */
const subjectId = z.enum(allSubjectIds());

/** A mode the frontend can force, e.g. from a "See a worked example" button. */
const mode = z.enum(MODES).optional();

/** Pagination, with `coerce` because query strings are always text. */
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** A time window for the insights endpoints. */
const insightsWindow = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

const router = Router();

// --- Health ------------------------------------------------------------------
// Outside /api/v1 because hosting platforms expect health checks at the root,
// and unversioned because they must keep working across API versions.

router.get('/health', metaController.health);
router.get('/health/ready', metaController.ready);

const v1 = Router();

// --- Auth --------------------------------------------------------------------

/** Creates an anonymous guest account. The frontend's very first call. */
v1.post('/auth/guest', generalLimiter, asyncHandler(authController.createGuest));

/** Exchanges a valid token for a fresh one. */
v1.post('/auth/refresh', generalLimiter, requireAuth, asyncHandler(authController.refresh));

/** Returns the current user. Handy as a "is my token still good?" check. */
v1.get('/auth/me', generalLimiter, requireAuth, asyncHandler(authController.me));

// --- Reference data ----------------------------------------------------------

/** The eight subjects. No auth: the landing page renders these before signup. */
v1.get('/subjects', generalLimiter, metaController.listSubjects);

/** Which AI providers are configured, and whether photo upload will work. */
v1.get('/meta/providers', generalLimiter, metaController.providers);

// --- Sessions ----------------------------------------------------------------

/** Starts a session. Runs the guardrails, then plans the steps. */
v1.post(
  '/sessions',
  aiLimiter,
  requireAuth,
  validateBody(z.object({
    subjectId,
    problem: z.string().trim().min(3, 'Tell Marg what you are stuck on.').max(4000),
    answerPolicy: z.enum(['never', 'on_request', 'after_attempt']).optional(),
  })),
  asyncHandler(sessionsController.create),
);

/** Lists the user's sessions, newest first. */
v1.get(
  '/sessions',
  generalLimiter,
  requireAuth,
  validateQuery(pagination),
  asyncHandler(sessionsController.list),
);

/** One session with its steps and full transcript. */
v1.get('/sessions/:id', generalLimiter, requireAuth, asyncHandler(sessionsController.get));

/** Renames a session. */
v1.patch(
  '/sessions/:id',
  generalLimiter,
  requireAuth,
  validateBody(z.object({ title: z.string().trim().min(1).max(120) })),
  asyncHandler(sessionsController.rename),
);

/** Deletes a session and everything attached to it. */
v1.delete('/sessions/:id', generalLimiter, requireAuth, asyncHandler(sessionsController.remove));

// --- Tutoring ----------------------------------------------------------------

/** Send a message, get the whole reply at once. */
v1.post(
  '/sessions/:id/ask',
  aiLimiter,
  requireAuth,
  validateBody(z.object({
    message: z.string().trim().min(1, 'Type something to ask.').max(4000),
    mode,
  })),
  asyncHandler(tutorController.ask),
);

/**
 * The same thing, streamed over SSE.
 *
 * A GET so the browser's built-in `EventSource` can call it directly — that
 * class only issues GETs and cannot set headers, which is also why `requireAuth`
 * accepts `?token=` here.
 */
v1.get(
  '/sessions/:id/ask/stream',
  aiLimiter,
  requireAuth,
  validateQuery(z.object({
    message: z.string().trim().min(1).max(4000),
    mode,
    token: z.string().optional(),
  })),
  asyncHandler(tutorController.askStream),
);

/** The smallest useful nudge. Does not count against the reveal gate. */
v1.post(
  '/sessions/:id/hint',
  aiLimiter,
  requireAuth,
  validateBody(z.object({ stepIndex: z.coerce.number().int().min(1).optional() })),
  asyncHandler(tutorController.hint),
);

/** The friction gate: first call hints, second call reveals. */
v1.post('/sessions/:id/reveal', aiLimiter, requireAuth, asyncHandler(tutorController.reveal));

/** Marks the student's working and names the step that broke. */
v1.post(
  '/sessions/:id/check',
  aiLimiter,
  requireAuth,
  validateBody(z.object({
    attempt: z.string().trim().min(1, 'Paste your working so Marg can mark it.').max(8000),
    stepId: z.string().optional(),
  })),
  asyncHandler(tutorController.check),
);

/** Explains one step in more depth. Never unlocks the final answer. */
v1.post(
  '/sessions/:id/explain',
  aiLimiter,
  requireAuth,
  validateBody(z.object({
    stepId: z.string().optional(),
    question: z.string().trim().max(1000).optional(),
  })),
  asyncHandler(tutorController.explain),
);

// --- Practice ----------------------------------------------------------------

/** "Give me 5 more like this." */
v1.post(
  '/sessions/:id/practice',
  aiLimiter,
  requireAuth,
  validateBody(z.object({
    count: z.coerce.number().int().min(1).max(10).default(3),
    skill: z.string().trim().max(120).optional(),
  })),
  asyncHandler(extrasController.generatePractice),
);

/** Marks a completed practice set. */
v1.post(
  '/practice/:setId/submit',
  aiLimiter,
  requireAuth,
  validateBody(z.object({
    answers: z.array(z.object({
      index: z.coerce.number().int().min(1),
      answer: z.string().max(2000),
    })).min(1),
  })),
  asyncHandler(extrasController.submitPractice),
);

// --- Concepts ----------------------------------------------------------------

/** Explains a concept with no problem attached. */
v1.post(
  '/concepts/explain',
  aiLimiter,
  requireAuth,
  validateBody(z.object({
    subjectId,
    concept: z.string().trim().min(2).max(300),
    depth: z.enum(['quick', 'standard', 'deep']).default('standard'),
  })),
  asyncHandler(extrasController.explainConcept),
);

// --- Insights ----------------------------------------------------------------

/** Recurring mistake patterns across the user's sessions. */
v1.get(
  '/insights/weaknesses',
  generalLimiter,
  requireAuth,
  validateQuery(insightsWindow),
  asyncHandler(extrasController.weaknesses),
);

/** How much the student has been working. */
v1.get(
  '/insights/activity',
  generalLimiter,
  requireAuth,
  validateQuery(insightsWindow),
  asyncHandler(extrasController.activity),
);

// --- Vision ------------------------------------------------------------------

/** Reads a photo of a page and returns every problem on it. */
v1.post(
  '/vision/transcribe',
  aiLimiter,
  requireAuth,
  upload.single('image'),
  asyncHandler(extrasController.transcribe),
);

router.use('/api/v1', v1);

export default router;
