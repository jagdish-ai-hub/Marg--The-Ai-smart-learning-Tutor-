/**
 * @file The in-memory store — where all data lives right now.
 *
 * IMPORTANT: everything here is lost when the server restarts. That is a
 * deliberate, temporary choice (see docs/ARCHITECTURE.md), not an oversight.
 *
 * Every method is `async` even though nothing here actually waits on anything.
 * That is the whole point: a real database *is* asynchronous, so writing the
 * interface this way now means swapping in Turso later changes only this file's
 * replacement — no service, route, or controller has to be touched.
 *
 * @example
 * import { store } from './store/index.js';
 * const session = await store.sessions.create({ userId, subjectId: 'mathematics', … });
 * await store.messages.append({ sessionId: session.id, role: 'user', content: 'hi' });
 */

import {
  newUserId,
  newSessionId,
  newMessageId,
  newStepId,
  newPracticeSetId,
  newMistakeId,
} from '../utils/ids.js';

/**
 * Creates a fresh in-memory store.
 *
 * Exposed as a factory rather than a singleton so tests can spin up an isolated
 * store per test file and never leak state between them.
 *
 * @returns {object} An object with `users`, `sessions`, `messages`, `steps`,
 *   `practiceSets`, and `mistakes` repositories, plus a `reset()` helper.
 */
export function createMemoryStore() {
  /** @type {Map<string, object>} userId -> user */
  const users = new Map();
  /** @type {Map<string, object>} sessionId -> session */
  const sessions = new Map();
  /** @type {Map<string, object[]>} sessionId -> messages, oldest first */
  const messages = new Map();
  /** @type {Map<string, object[]>} sessionId -> steps, in order */
  const steps = new Map();
  /** @type {Map<string, object>} setId -> practice set */
  const practiceSets = new Map();
  /** @type {Map<string, object[]>} userId -> mistake-log entries */
  const mistakes = new Map();

  /** @returns {string} The current time as an ISO 8601 string. */
  const now = () => new Date().toISOString();

  /**
   * Returns a deep copy so callers cannot accidentally mutate stored state.
   *
   * A real database hands you a detached row; without this the in-memory store
   * would hand you a live reference and behave subtly differently, hiding bugs
   * that would only appear after the migration.
   *
   * @param {any} value - Anything JSON-serialisable.
   * @returns {any} An independent copy.
   */
  const copy = (value) => (value === undefined ? undefined : structuredClone(value));

  return {
    /** Anonymous guest accounts. */
    users: {
      /**
       * Creates a new guest user.
       *
       * @returns {Promise<object>} The created user.
       */
      async create() {
        const user = { id: newUserId(), isGuest: true, createdAt: now(), lastSeenAt: now() };
        users.set(user.id, user);
        return copy(user);
      },

      /**
       * Looks up a user.
       *
       * @param {string} id - User id.
       * @returns {Promise<object|null>} The user, or `null` if unknown.
       */
      async findById(id) {
        return copy(users.get(id)) ?? null;
      },

      /**
       * Records that a user just made a request. Used by `GET /auth/me`.
       *
       * @param {string} id - User id.
       * @returns {Promise<void>}
       */
      async touch(id) {
        const user = users.get(id);
        if (user) user.lastSeenAt = now();
      },
    },

    /** Tutoring sessions — one per problem the student brings. */
    sessions: {
      /**
       * Creates a session.
       *
       * @param {object} data - Session fields. `userId` and `subjectId` are required.
       * @returns {Promise<object>} The created session.
       */
      async create(data) {
        const session = {
          id: newSessionId(),
          status: 'active',
          currentStepIndex: 1,
          revealCount: 0,
          attemptCount: 0,
          createdAt: now(),
          updatedAt: now(),
          ...data,
        };
        sessions.set(session.id, session);
        messages.set(session.id, []);
        steps.set(session.id, []);
        return copy(session);
      },

      /**
       * Finds a session, but only if it belongs to this user.
       *
       * Ownership is checked here rather than in every caller, so it cannot be
       * forgotten in one route and quietly leak another student's work.
       *
       * @param {string} id - Session id.
       * @param {string} userId - The requesting user.
       * @returns {Promise<object|null>} The session, or `null` if missing or not theirs.
       */
      async findById(id, userId) {
        const session = sessions.get(id);
        if (!session || session.userId !== userId) return null;
        return copy(session);
      },

      /**
       * Lists a user's sessions, newest first.
       *
       * @param {string} userId - Whose sessions to list.
       * @param {object} [options]
       * @param {number} [options.limit=20] - Page size.
       * @param {number} [options.offset=0] - How many to skip.
       * @returns {Promise<{items: object[], total: number}>}
       */
      async listByUser(userId, { limit = 20, offset = 0 } = {}) {
        const all = [...sessions.values()]
          .filter((session) => session.userId === userId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        return { items: copy(all.slice(offset, offset + limit)), total: all.length };
      },

      /**
       * Applies partial changes to a session.
       *
       * @param {string} id - Session id.
       * @param {object} changes - Fields to overwrite.
       * @returns {Promise<object|null>} The updated session, or `null` if unknown.
       */
      async update(id, changes) {
        const session = sessions.get(id);
        if (!session) return null;
        Object.assign(session, changes, { updatedAt: now() });
        return copy(session);
      },

      /**
       * Deletes a session and everything attached to it.
       *
       * @param {string} id - Session id.
       * @returns {Promise<boolean>} True if something was deleted.
       */
      async remove(id) {
        messages.delete(id);
        steps.delete(id);
        return sessions.delete(id);
      },
    },

    /** The conversation transcript. */
    messages: {
      /**
       * Adds a message to the end of a session's transcript.
       *
       * @param {object} data - Must include `sessionId`, `role`, and `content`.
       * @returns {Promise<object>} The stored message.
       */
      async append(data) {
        const message = { id: newMessageId(), createdAt: now(), ...data };
        const list = messages.get(data.sessionId) ?? [];
        list.push(message);
        messages.set(data.sessionId, list);
        return copy(message);
      },

      /**
       * Reads a session's transcript, oldest first.
       *
       * @param {string} sessionId - Which session.
       * @param {object} [options]
       * @param {number} [options.limit] - Return only the most recent N messages.
       * @returns {Promise<object[]>} The messages.
       */
      async listBySession(sessionId, { limit } = {}) {
        const list = messages.get(sessionId) ?? [];
        return copy(limit ? list.slice(-limit) : list);
      },
    },

    /** The numbered steps shown on the session card. */
    steps: {
      /**
       * Replaces a session's steps with a new ordered set.
       *
       * @param {string} sessionId - Which session.
       * @param {Array<{instruction: string, skill: string}>} items - Steps in order.
       * @returns {Promise<object[]>} The created steps, with ids and 1-based indexes.
       */
      async replaceAll(sessionId, items) {
        const created = items.map((item, position) => ({
          id: newStepId(),
          sessionId,
          // 1-based because the UI shows "01", "02", "03" — matching the
          // display avoids constant off-by-one confusion in logs and prompts.
          index: position + 1,
          instruction: item.instruction,
          skill: item.skill,
          status: position === 0 ? 'active' : 'pending',
          createdAt: now(),
        }));
        steps.set(sessionId, created);
        return copy(created);
      },

      /**
       * Lists a session's steps in order.
       *
       * @param {string} sessionId - Which session.
       * @returns {Promise<object[]>} The steps.
       */
      async listBySession(sessionId) {
        return copy(steps.get(sessionId) ?? []);
      },

      /**
       * Finds one step by its id.
       *
       * @param {string} sessionId - Which session.
       * @param {string} stepId - Which step.
       * @returns {Promise<object|null>} The step, or `null`.
       */
      async findById(sessionId, stepId) {
        const found = (steps.get(sessionId) ?? []).find((step) => step.id === stepId);
        return copy(found) ?? null;
      },

      /**
       * Sets the status of one step, addressed by its 1-based index.
       *
       * @param {string} sessionId - Which session.
       * @param {number} index - 1-based step index.
       * @param {string} status - `pending`, `active`, `correct`, `incorrect`, or `revealed`.
       * @returns {Promise<object|null>} The updated step, or `null`.
       */
      async setStatus(sessionId, index, status) {
        const step = (steps.get(sessionId) ?? []).find((item) => item.index === index);
        if (!step) return null;
        step.status = status;
        return copy(step);
      },
    },

    /** Generated practice sets. */
    practiceSets: {
      /**
       * Stores a generated practice set.
       *
       * @param {object} data - Must include `userId`, `skill`, and `problems`.
       * @returns {Promise<object>} The stored set.
       */
      async create(data) {
        const set = { id: newPracticeSetId(), createdAt: now(), submittedAt: null, ...data };
        practiceSets.set(set.id, set);
        return copy(set);
      },

      /**
       * Finds a practice set, but only if it belongs to this user.
       *
       * @param {string} id - Set id.
       * @param {string} userId - The requesting user.
       * @returns {Promise<object|null>} The set, or `null`.
       */
      async findById(id, userId) {
        const set = practiceSets.get(id);
        if (!set || set.userId !== userId) return null;
        return copy(set);
      },

      /**
       * Applies partial changes to a practice set.
       *
       * @param {string} id - Set id.
       * @param {object} changes - Fields to overwrite.
       * @returns {Promise<object|null>} The updated set, or `null`.
       */
      async update(id, changes) {
        const set = practiceSets.get(id);
        if (!set) return null;
        Object.assign(set, changes);
        return copy(set);
      },
    },

    /**
     * The mistake log — the raw material behind the weakness report.
     *
     * Every time marking finds an error we record one row here. On its own a
     * single row is not interesting; the value is in the pattern across weeks
     * ("dropped the negative when dividing — four times this week"), which is
     * something a human tutor notices and a grading app never does.
     */
    mistakes: {
      /**
       * Records one mistake.
       *
       * @param {object} data - Must include `userId`, `errorType`, and `skill`.
       * @returns {Promise<object>} The stored entry.
       */
      async record(data) {
        const entry = { id: newMistakeId(), createdAt: now(), ...data };
        const list = mistakes.get(data.userId) ?? [];
        list.push(entry);
        mistakes.set(data.userId, list);
        return copy(entry);
      },

      /**
       * Lists a user's mistakes, newest first.
       *
       * @param {string} userId - Whose mistakes.
       * @param {object} [options]
       * @param {string} [options.since] - ISO timestamp; only return entries after it.
       * @returns {Promise<object[]>} The entries.
       */
      async listByUser(userId, { since } = {}) {
        let list = mistakes.get(userId) ?? [];
        if (since) list = list.filter((entry) => entry.createdAt >= since);
        return copy([...list].reverse());
      },
    },

    /**
     * Wipes everything. Used by tests between cases; never called in production.
     *
     * @returns {Promise<void>}
     */
    async reset() {
      users.clear();
      sessions.clear();
      messages.clear();
      steps.clear();
      practiceSets.clear();
      mistakes.clear();
    },
  };
}
