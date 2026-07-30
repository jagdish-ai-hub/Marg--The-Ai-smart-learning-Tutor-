/**
 * @file The mistake log turned into something a student can act on.
 *
 * One wrong answer tells you nothing. The same wrong answer four times tells
 * you exactly what to practise. This is the thing a good human tutor does that
 * a grading app never does: they remember last week.
 *
 * Deliberately arithmetic rather than AI. Counting mistakes is counting — it
 * should be instant, free, and identical every time you load the page. The AI
 * already did the hard part when it tagged each mistake during marking.
 */

import { store } from '../store/index.js';

/** How far back the weakness report looks, in days. */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Turns an error tag into something readable.
 *
 * Falls back to un-snake_casing anything unrecognised, so a new tag from the
 * model still displays sensibly instead of showing raw `unit_conversion`.
 *
 * @private
 * @type {Record<string, string>}
 */
const ERROR_LABELS = {
  sign_error: 'Sign errors',
  arithmetic_slip: 'Arithmetic slips',
  wrong_formula: 'Choosing the wrong formula',
  unit_conversion: 'Unit conversions',
  off_by_one: 'Off-by-one errors',
  algebra_rearrangement: 'Rearranging algebra',
  misread_question: 'Misreading the question',
  incomplete_working: 'Stopping before the end',
  concept_confusion: 'Mixing up two concepts',
};

/**
 * Makes an error tag human-readable.
 *
 * @private
 * @param {string} errorType - A snake_case tag.
 * @returns {string} A display label.
 */
function labelFor(errorType) {
  if (ERROR_LABELS[errorType]) return ERROR_LABELS[errorType];
  const words = errorType.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Writes the one-line summary a student actually reads.
 *
 * @private
 * @param {object} pattern - An aggregated pattern.
 * @returns {string} e.g. `"Sign errors came up 4 times this week, mostly in factoring."`
 */
function summarise(pattern) {
  const label = labelFor(pattern.errorType).toLowerCase();
  const times = pattern.count === 1 ? 'once' : `${pattern.count} times`;
  const where = pattern.topSkill ? `, mostly in ${pattern.topSkill}` : '';
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} came up ${times}${where}.`;
}

/**
 * Finds the recurring mistake patterns in a user's history.
 *
 * @param {object} options
 * @param {string} options.userId - Whose history.
 * @param {number} [options.days=30] - How far back to look.
 * @param {number} [options.limit=5] - Maximum patterns to return.
 * @returns {Promise<{windowDays: number, totalMistakes: number, patterns: object[]}>}
 *   Patterns are sorted most frequent first. An empty list is normal and means
 *   the student has not made enough mistakes yet to show a pattern.
 *
 * @example
 * const { patterns } = await getWeaknesses({ userId });
 * patterns[0].summary; // 'Sign errors came up 4 times, mostly in factoring.'
 */
export async function getWeaknesses({ userId, days = DEFAULT_WINDOW_DAYS, limit = 5 }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const mistakes = await store.mistakes.listByUser(userId, { since });

  /** @type {Map<string, object>} errorType -> aggregate */
  const grouped = new Map();

  for (const mistake of mistakes) {
    const existing = grouped.get(mistake.errorType) ?? {
      errorType: mistake.errorType,
      label: labelFor(mistake.errorType),
      count: 0,
      skills: new Map(),
      subjects: new Set(),
      lastSeenAt: mistake.createdAt,
      examples: [],
    };

    existing.count += 1;
    existing.skills.set(mistake.skill, (existing.skills.get(mistake.skill) ?? 0) + 1);
    if (mistake.subjectId) existing.subjects.add(mistake.subjectId);

    // Entries arrive newest first, so the first one seen is the most recent.
    if (mistake.createdAt > existing.lastSeenAt) existing.lastSeenAt = mistake.createdAt;

    // Keep a couple of concrete examples: "sign errors, 4 times" is abstract,
    // but seeing the actual sentence makes a student recognise the habit.
    if (existing.examples.length < 2 && mistake.errorSummary) {
      existing.examples.push(mistake.errorSummary);
    }

    grouped.set(mistake.errorType, existing);
  }

  const patterns = [...grouped.values()]
    .map((pattern) => {
      const [topSkill] = [...pattern.skills.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null];
      const shaped = {
        errorType: pattern.errorType,
        label: pattern.label,
        count: pattern.count,
        topSkill,
        subjects: [...pattern.subjects],
        lastSeenAt: pattern.lastSeenAt,
        examples: pattern.examples,
      };
      return { ...shaped, summary: summarise(shaped) };
    })
    .sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, limit);

  return { windowDays: days, totalMistakes: mistakes.length, patterns };
}

/**
 * Summarises how much a student has been working.
 *
 * @param {object} options
 * @param {string} options.userId - Whose activity.
 * @param {number} [options.days=30] - How far back to look.
 * @returns {Promise<object>} Session and step counts, plus a per-subject breakdown.
 */
export async function getActivity({ userId, days = DEFAULT_WINDOW_DAYS }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // A generous page size: this is a summary, so it needs the whole window
  // rather than the first page of it.
  const { items: sessions, total } = await store.sessions.listByUser(userId, { limit: 500 });
  const recent = sessions.filter((session) => session.createdAt >= since);

  /** @type {Map<string, number>} subjectId -> session count */
  const bySubject = new Map();
  let stepsCompleted = 0;

  for (const session of recent) {
    bySubject.set(session.subjectId, (bySubject.get(session.subjectId) ?? 0) + 1);
    const steps = await store.steps.listBySession(session.id);
    stepsCompleted += steps.filter((step) => step.status === 'correct').length;
  }

  return {
    windowDays: days,
    totalSessions: total,
    sessionsInWindow: recent.length,
    completedInWindow: recent.filter((session) => session.status === 'completed').length,
    stepsCompleted,
    bySubject: [...bySubject.entries()]
      .map(([subjectId, count]) => ({ subjectId, count }))
      .sort((a, b) => b.count - a.count),
  };
}
