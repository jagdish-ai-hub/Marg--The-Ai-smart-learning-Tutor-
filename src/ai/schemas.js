/**
 * @file The exact shapes we ask the AI to reply in, defined once.
 *
 * Some of Marg's AI calls must return structured data, not prose — a step plan
 * has to be a list we can render as a numbered card, and a marking result has
 * to say precisely which step broke. For those we do two things:
 *
 *   1. Tell the provider the shape up front ("structured output" / "JSON mode").
 *      Gemini and OpenAI-style APIs both support this, they just spell it
 *      differently, so each schema below is written once in plain JSON Schema
 *      and converted per provider.
 *   2. Validate whatever comes back with Zod, because "the model promised" is
 *      not the same as "the model delivered".
 *
 * Free-text replies (chat, hints, explanations) skip all of this — they are
 * meant to read naturally, so forcing them into JSON would only hurt.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Triage — one cheap call that decides "should we help, and how?"
// ---------------------------------------------------------------------------

/**
 * Result of the triage call that runs before the main teaching call.
 *
 * This single small request answers both questions Marg needs at the start of
 * a turn: *is this something we should help with* (scope + academic integrity)
 * and *what kind of help is being asked for* (the mode). Combining them into
 * one call halves the latency and cost versus asking separately.
 */
export const TriageSchema = z.object({
  /** True when the message is study-related, or is a question about Marg itself. */
  inScope: z.boolean(),
  /**
   * `academic` — a real study question.
   * `meta` — about Marg itself ("what can you do?"), always allowed.
   * `off_topic` — not study-related at all.
   */
  category: z.enum(['academic', 'meta', 'off_topic']),
  /** Best guess at the subject id, or null if unclear. */
  subjectId: z.string().nullable(),
  /**
   * How much this looks like "do my assignment for me" rather than "teach me".
   * `none` — normal learning question.
   * `low`  — wants a lot done for them, but still engaged in learning.
   * `high` — asking Marg to produce the graded artifact itself.
   */
  integrityRisk: z.enum(['none', 'low', 'high']),
  /** What kind of help is wanted. See docs/TUTORING-MODEL.md. */
  mode: z.enum(['guide', 'explain', 'discuss', 'check']),
  /** True when the student is explicitly asking for the final answer. */
  wantsAnswer: z.boolean(),
  /**
   * One short sentence explaining the call. Logged, never shown to students —
   * and never read for any functional decision, which is exactly why this is
   * optional. Providers without strict schema enforcement (anything running
   * through the json_object fallback in openaiCompatible.js) don't reliably
   * include every field the prompt asks for, and this is the one field that
   * is safe to simply go missing.
   */
  reason: z.string().optional(),
});

/** @see TriageSchema */
export const triageJsonSchema = {
  type: 'object',
  properties: {
    inScope: { type: 'boolean' },
    category: { type: 'string', enum: ['academic', 'meta', 'off_topic'] },
    subjectId: { type: 'string', nullable: true },
    integrityRisk: { type: 'string', enum: ['none', 'low', 'high'] },
    mode: { type: 'string', enum: ['guide', 'explain', 'discuss', 'check'] },
    wantsAnswer: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['inScope', 'category', 'integrityRisk', 'mode', 'wantsAnswer'],
};

// ---------------------------------------------------------------------------
// Step plan — the numbered card the student works through
// ---------------------------------------------------------------------------

/**
 * A problem broken into the ordered steps shown on the session card.
 *
 * `finalAnswer` is deliberately part of this shape but is **never sent to the
 * client** with the plan. It is stored server-side so that the reveal gate
 * (see `tutorService`) can hand it over later without a second AI call. If we
 * shipped it with the plan, anyone could read the answer straight out of the
 * network tab — which would quietly defeat the entire product.
 */
export const StepPlanSchema = z.object({
  /** Short session title, e.g. "Quadratic equations". */
  title: z.string(),
  /** The specific skill involved, e.g. "Factoring quadratics". */
  topic: z.string(),
  /** The problem restated cleanly, e.g. "solve 2x² − 5x − 3 = 0". */
  restatedProblem: z.string(),
  /** The ordered steps. Between 2 and 8 — fewer is uselessly vague, more is overwhelming. */
  steps: z
    .array(
      z.object({
        /** What to do at this step, phrased as an instruction to the student. */
        instruction: z.string(),
        /** The underlying skill, used later to generate practice and spot weaknesses. */
        skill: z.string(),
      }),
    )
    .min(1)
    .max(10),
  /** The worked final answer. Held back until the student unlocks it. */
  finalAnswer: z.string(),
});

/** @see StepPlanSchema */
export const stepPlanJsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    topic: { type: 'string' },
    restatedProblem: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          instruction: { type: 'string' },
          skill: { type: 'string' },
        },
        required: ['instruction', 'skill'],
      },
    },
    finalAnswer: { type: 'string' },
  },
  required: ['title', 'topic', 'restatedProblem', 'steps', 'finalAnswer'],
};

// ---------------------------------------------------------------------------
// Marking — "get marked, not just graded"
// ---------------------------------------------------------------------------

/**
 * The result of checking a student's attempt.
 *
 * This is the product's centrepiece. A grader says "wrong". Marg says *which
 * step* went sideways, *why*, and what to try next — and tags the mistake so
 * the weakness report can spot the same error recurring next week.
 */
export const MarkingSchema = z.object({
  /** Verdict on the attempt as a whole. */
  overall: z.enum(['correct', 'partially_correct', 'incorrect']),
  /**
   * 1-based index of the first step that went wrong, or null when everything
   * is correct. This is what the UI circles.
   */
  firstBrokenStepIndex: z.number().int().min(1).nullable(),
  /** Per-step verdicts, in order. */
  steps: z.array(
    z.object({
      index: z.number().int().min(1),
      verdict: z.enum(['correct', 'partially_correct', 'incorrect', 'not_attempted']),
      /** One sentence on this specific step. Encouraging when correct. */
      comment: z.string(),
    }),
  ),
  /**
   * A short snake_case tag for the kind of mistake, e.g. `sign_error`,
   * `arithmetic_slip`, `wrong_formula`, `unit_conversion`, `off_by_one`.
   * Null when the attempt is fully correct. Feeds the mistake log.
   */
  errorType: z.string().nullable(),
  /** Plain-language description of the mistake, or null when correct. */
  errorSummary: z.string().nullable(),
  /** What to try next. Never contains the final answer. */
  nudge: z.string(),
});

/** @see MarkingSchema */
export const markingJsonSchema = {
  type: 'object',
  properties: {
    overall: { type: 'string', enum: ['correct', 'partially_correct', 'incorrect'] },
    firstBrokenStepIndex: { type: 'integer', nullable: true },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: {
            type: 'string',
            enum: ['correct', 'partially_correct', 'incorrect', 'not_attempted'],
          },
          comment: { type: 'string' },
        },
        required: ['index', 'verdict', 'comment'],
      },
    },
    errorType: { type: 'string', nullable: true },
    errorSummary: { type: 'string', nullable: true },
    nudge: { type: 'string' },
  },
  required: ['overall', 'steps', 'nudge'],
};

// ---------------------------------------------------------------------------
// Practice — "give me 5 more like this"
// ---------------------------------------------------------------------------

/** A set of fresh problems targeting the same skill the student just worked on. */
export const PracticeSchema = z.object({
  /** The skill these problems drill. */
  skill: z.string(),
  problems: z.array(
    z.object({
      /** The problem as the student will see it. */
      prompt: z.string(),
      /** Relative difficulty, so the UI can show a ramp. */
      difficulty: z.enum(['easier', 'same', 'harder']),
      /** The answer, kept server-side until the student submits. */
      answer: z.string(),
    }),
  ).min(1).max(10),
});

/** @see PracticeSchema */
export const practiceJsonSchema = {
  type: 'object',
  properties: {
    skill: { type: 'string' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          difficulty: { type: 'string', enum: ['easier', 'same', 'harder'] },
          answer: { type: 'string' },
        },
        required: ['prompt', 'difficulty', 'answer'],
      },
    },
  },
  required: ['skill', 'problems'],
};

// ---------------------------------------------------------------------------
// Vision — a photo of a worksheet
// ---------------------------------------------------------------------------

/**
 * Everything readable on a photographed page.
 *
 * A snapped textbook page usually holds several problems, so we return all of
 * them and let the student pick — one photo, not one photo per question.
 */
export const TranscriptionSchema = z.object({
  /** Best guess at the subject, or null. */
  subjectId: z.string().nullable(),
  problems: z.array(
    z.object({
      /** The question number printed on the page, e.g. "4b". Null if unnumbered. */
      label: z.string().nullable(),
      /** The problem text, transcribed as faithfully as possible. */
      text: z.string(),
    }),
  ),
  /** Any of the student's own handwritten working that was visible, or null. */
  studentWorking: z.string().nullable(),
});

/** @see TranscriptionSchema */
export const transcriptionJsonSchema = {
  type: 'object',
  properties: {
    subjectId: { type: 'string', nullable: true },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', nullable: true },
          text: { type: 'string' },
        },
        required: ['text'],
      },
    },
    studentWorking: { type: 'string', nullable: true },
  },
  required: ['problems'],
};

// ---------------------------------------------------------------------------
// Provider-specific conversion
// ---------------------------------------------------------------------------

/**
 * Converts one of the plain JSON Schemas above into Gemini's `responseSchema`
 * dialect.
 *
 * Gemini uses an OpenAPI-flavoured subset: type names are uppercase
 * (`"STRING"`, not `"string"`) and it rejects keywords it does not recognise,
 * so anything unsupported is dropped rather than passed through.
 *
 * @param {object} schema - A plain JSON Schema object from this file.
 * @returns {object} The same schema in Gemini's format.
 *
 * @example
 * toGeminiSchema({ type: 'string' }); // { type: 'STRING' }
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  const converted = {};

  if (schema.type) converted.type = String(schema.type).toUpperCase();
  if (schema.description) converted.description = schema.description;
  if (schema.enum) converted.enum = schema.enum;
  if (schema.nullable) converted.nullable = true;

  if (schema.properties) {
    converted.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      converted.properties[key] = toGeminiSchema(value);
    }
  }
  if (schema.items) converted.items = toGeminiSchema(schema.items);
  if (schema.required) converted.required = schema.required;

  return converted;
}

/**
 * Wraps one of the plain JSON Schemas above for an OpenAI-style
 * `response_format: { type: 'json_schema', ... }` request.
 *
 * Strict mode requires `additionalProperties: false` on every object and every
 * property listed in `required`, so this walks the schema and enforces both.
 *
 * @param {string} name - A name for the schema, e.g. `'step_plan'`.
 * @param {object} schema - A plain JSON Schema object from this file.
 * @returns {object} The `response_format` value to send.
 */
export function toOpenAiResponseFormat(name, schema) {
  return {
    type: 'json_schema',
    json_schema: {
      name,
      strict: true,
      schema: enforceStrict(schema),
    },
  };
}

/**
 * Recursively prepares a schema for OpenAI strict mode.
 *
 * Strict mode demands that `required` list *every* property. Fields we treat as
 * optional are made nullable instead, which expresses the same thing in a way
 * strict mode accepts.
 *
 * @private
 * @param {object} schema - A plain JSON Schema object.
 * @returns {object} A strict-mode-safe copy.
 */
function enforceStrict(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  const copy = { ...schema };

  if (copy.type === 'object' && copy.properties) {
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties).map(([key, value]) => [key, enforceStrict(value)]),
    );
    copy.additionalProperties = false;
    copy.required = Object.keys(copy.properties);
  }

  if (copy.items) copy.items = enforceStrict(copy.items);

  // `nullable: true` is JSON Schema draft-4 style; OpenAI wants a type union.
  if (copy.nullable) {
    delete copy.nullable;
    copy.type = Array.isArray(copy.type) ? copy.type : [copy.type, 'null'];
  }

  return copy;
}
