/**
 * @file The subjects Marg tutors — the eight tiles on the landing page.
 *
 * This is a plain list, not database rows, because the set changes about once a
 * year and is the same for every user. Serving it from an endpoint (rather than
 * hardcoding it in the frontend) means adding a subject is a backend deploy and
 * the app picks it up with no frontend release.
 */

/**
 * One subject a student can start a session in.
 *
 * @typedef {object} Subject
 * @property {string} id - Stable identifier used in API requests, e.g. `'mathematics'`.
 * @property {string} label - Display name, e.g. `'Mathematics'`.
 * @property {string} accent - Colour token for the dot on the tile. The frontend
 *   maps this to its own palette; the backend never sends raw hex codes.
 * @property {string} blurb - One line describing what Marg helps with here.
 * @property {string[]} examples - Sample problems, useful as UI placeholder text.
 */

/**
 * Every subject, in the order the landing page shows them.
 *
 * @type {ReadonlyArray<Subject>}
 */
export const SUBJECTS = Object.freeze([
  {
    id: 'mathematics',
    label: 'Mathematics',
    accent: 'amber',
    blurb: 'Algebra, calculus, geometry, statistics — worked one step at a time.',
    examples: ['Solve 2x² − 5x − 3 = 0', 'Differentiate x·sin(x)', 'Find the median of this data set'],
  },
  {
    id: 'physics',
    label: 'Physics',
    accent: 'blue',
    blurb: 'Mechanics, electricity, waves, thermodynamics — with the reasoning shown.',
    examples: ['A block slides down a 30° incline…', 'Find the current through R₂', 'Why is momentum conserved here?'],
  },
  {
    id: 'chemistry',
    label: 'Chemistry',
    accent: 'green',
    blurb: 'Balancing, stoichiometry, organic mechanisms, bonding.',
    examples: ['Balance C₃H₈ + O₂ → CO₂ + H₂O', 'How many moles in 24 g of carbon?', 'Draw the mechanism for SN2'],
  },
  {
    id: 'programming',
    label: 'Programming',
    accent: 'rose',
    blurb: 'Debugging, algorithms, data structures — Marg helps you find the bug, not hand you the file.',
    examples: ['Why does my loop go out of bounds?', 'Explain recursion with a small example', 'What is the complexity of this function?'],
  },
  {
    id: 'biology',
    label: 'Biology',
    accent: 'amber',
    blurb: 'Cells, genetics, physiology, ecology.',
    examples: ['Work through this monohybrid cross', 'Why does the cell shrink in salt water?', 'Trace blood through the heart'],
  },
  {
    id: 'economics',
    label: 'Economics',
    accent: 'blue',
    blurb: 'Micro, macro, graphs and the reasoning behind them.',
    examples: ['Show the effect of a price ceiling', 'Calculate price elasticity here', 'Why does the AD curve shift?'],
  },
  {
    id: 'languages',
    label: 'Languages',
    accent: 'green',
    blurb: 'Grammar, translation, comprehension, literary analysis.',
    examples: ['Why is it "por" and not "para"?', 'Analyse the metaphor in this stanza', 'Check my French translation'],
  },
  {
    id: 'standardized-tests',
    label: 'Standardized tests',
    accent: 'rose',
    blurb: 'SAT, ACT, GRE, JEE, NEET — technique as well as content.',
    examples: ['Walk me through this SAT geometry question', 'Faster way to do this JEE integral?', 'Why is B wrong here?'],
  },
]);

/** Fast lookup by id, built once at startup. */
const byId = new Map(SUBJECTS.map((subject) => [subject.id, subject]));

/**
 * Finds a subject by its id.
 *
 * @param {string} id - Subject id, e.g. `'physics'`.
 * @returns {Subject|undefined} The subject, or `undefined` if the id is unknown.
 *
 * @example
 * findSubject('physics');  // { id: 'physics', label: 'Physics', … }
 * findSubject('astrology'); // undefined
 */
export function findSubject(id) {
  return byId.get(id);
}

/**
 * Checks whether a subject id is one we support.
 *
 * @param {string} id - Subject id to check.
 * @returns {boolean}
 */
export function isValidSubject(id) {
  return byId.has(id);
}

/**
 * All valid subject ids. Handy for building validation schemas and for putting
 * the list into a prompt.
 *
 * @returns {string[]}
 */
export function allSubjectIds() {
  return SUBJECTS.map((subject) => subject.id);
}
