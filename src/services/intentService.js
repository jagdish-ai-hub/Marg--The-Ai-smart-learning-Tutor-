/**
 * @file Works out which of the four modes a turn should run in.
 *
 * THE FOUR MODES
 *   guide   — walk through the current step, ask the student to try it
 *   explain — answer "why does this work?", give a worked example
 *   discuss — a concept question with no specific step attached
 *   check   — mark an attempt the student submitted
 *
 * Two ways in, one destination. The frontend can force a mode (backing real
 * buttons like "See a worked example ↓" or "Check my work"), and when it does
 * not, the triage classifier reads it from the message. So a student tapping a
 * button and a student typing "just tell me the answer" both land in the right
 * place — which is what makes the stepped card and the loose chat bubbles feel
 * like one product rather than two.
 */

/** The modes a caller is allowed to ask for. */
const VALID_MODES = ['guide', 'explain', 'discuss', 'check'];

/**
 * Chooses the mode for this turn.
 *
 * An explicit mode from the frontend always wins. The student pressed a button;
 * second-guessing them with a classifier would be both surprising and worse.
 *
 * @param {object} options
 * @param {string} [options.requestedMode] - Mode passed by the frontend, if any.
 * @param {object} options.triage - The triage result.
 * @param {string} [options.attempt] - The student's submitted working, if any.
 * @returns {{mode: string, source: 'explicit'|'attempt'|'inferred'}}
 *   The chosen mode and why it was chosen. `source` is logged, and is genuinely
 *   useful when working out why Marg behaved unexpectedly.
 *
 * @example
 * resolveMode({ requestedMode: 'explain', triage });  // { mode: 'explain', source: 'explicit' }
 * resolveMode({ triage, attempt: 'x = 3' });          // { mode: 'check',   source: 'attempt' }
 */
export function resolveMode({ requestedMode, triage, attempt }) {
  if (requestedMode && VALID_MODES.includes(requestedMode)) {
    return { mode: requestedMode, source: 'explicit' };
  }

  // Working was submitted, so this is a marking turn whatever the words say.
  // A student who pastes their attempt and writes "I think this is right?"
  // wants it checked, not discussed.
  if (attempt && attempt.trim()) {
    return { mode: 'check', source: 'attempt' };
  }

  return { mode: triage.mode ?? 'guide', source: 'inferred' };
}

/**
 * Checks whether a caller-supplied mode is one we recognise.
 *
 * @param {string} mode - The value to check.
 * @returns {boolean}
 */
export function isValidMode(mode) {
  return VALID_MODES.includes(mode);
}

/** @type {string[]} The four valid modes, for validation schemas and docs. */
export const MODES = VALID_MODES;
