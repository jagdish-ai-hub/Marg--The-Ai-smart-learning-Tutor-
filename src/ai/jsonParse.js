/**
 * @file Extracts JSON from an AI model's reply, tolerating the usual mess.
 *
 * WHY THIS IS NEEDED
 * When you ask a model for JSON, most of the time you get clean JSON. But
 * sometimes you get:
 *
 *   Sure! Here's the JSON:
 *   ```json
 *   { "steps": [...] }
 *   ```
 *   Let me know if you need anything else.
 *
 * `JSON.parse` chokes on all of that. Rather than failing the student's
 * request over a stray sentence, we strip the noise and try again.
 *
 * @example
 * parseJsonLoose('```json\n{"a":1}\n```'); // { a: 1 }
 * parseJsonLoose('nonsense');              // null
 */

/**
 * Attempts to pull a JSON value out of arbitrary model text.
 *
 * Tries, in order:
 *   1. Parse the whole string as-is (the common case).
 *   2. Strip a surrounding ```json fence and parse that.
 *   3. Grab the outermost `{...}` or `[...]` and parse that.
 *
 * @param {string} text - Raw text from the model.
 * @returns {any|null} The parsed value, or `null` if nothing worked.
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  // Strip a markdown code fence, with or without a language tag.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Last resort: take everything between the first opening bracket and the
  // last matching closing one. Handles chatty preambles and sign-offs.
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const start =
    firstBrace === -1 ? firstBracket
      : firstBracket === -1 ? firstBrace
        : Math.min(firstBrace, firstBracket);

  if (start !== -1) {
    const opener = text[start];
    const closer = opener === '{' ? '}' : ']';
    const end = text.lastIndexOf(closer);
    if (end > start) {
      const parsed = tryParse(text.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
    }
  }

  return null;
}

/**
 * `JSON.parse` that returns `undefined` instead of throwing.
 *
 * We use `undefined` for failure rather than `null` because `null` is itself
 * valid JSON — `tryParse('null')` must be distinguishable from a parse error.
 *
 * @private
 * @param {string} candidate - Text to parse.
 * @returns {any|undefined} The parsed value, or `undefined` on failure.
 */
function tryParse(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Parses JSON from a model reply and validates it with a Zod schema.
 *
 * This is the function services should call. It gives you either a value you
 * can trust completely, or a clear failure — never a half-valid object that
 * blows up three functions later.
 *
 * @param {string} text - Raw text from the model.
 * @param {import('zod').ZodType} schema - Zod schema describing the expected shape.
 * @returns {{ ok: true, data: any } | { ok: false, reason: string }}
 *   `ok: true` with the validated data, or `ok: false` with why it failed.
 *
 * @example
 * const result = parseJsonWithSchema(reply.text, StepPlanSchema);
 * if (!result.ok) throw ApiError.provider('PROVIDER_BAD_RESPONSE', result.reason);
 * const plan = result.data; // fully validated
 */
export function parseJsonWithSchema(text, schema) {
  const raw = parseJsonLoose(text);
  if (raw === null) {
    return { ok: false, reason: 'The AI did not return anything that looks like JSON.' };
  }

  const validated = schema.safeParse(raw);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: `The AI returned JSON in an unexpected shape — ${issues}` };
  }

  return { ok: true, data: validated.data };
}
