/**
 * @file The single door to stored data.
 *
 * Nothing outside this folder knows *how* data is stored. Services import
 * `store` and call `store.sessions.findById(...)`; whether that hits a `Map`
 * or Postgres is decided here and nowhere else.
 *
 * TWO BACKENDS, ONE INTERFACE
 * A guest's work lives entirely in memory (`memory.js`) — free, instant, and
 * gone on restart, which is the whole deal: no signup, no promise it sticks
 * around. A signed-in student's sessions live in Postgres (`pgSessionStore.js`)
 * instead, because they made an account specifically so their history
 * survives. `store.users` is simpler still: guests vs signed-in accounts are
 * already two entirely separate repositories (`memory.js`'s `users` and
 * `pgUsers.js`), picked directly by `middleware/auth.js` from the request's
 * own token — this file never touches that choice.
 *
 * For everything else (sessions, steps, messages, practice sets, mistakes),
 * this file is a thin router: every id in this app is prefixed by kind
 * (`ses_`, `msg_`, …) *and*, for the kinds that can live in either backend,
 * by which one owns it — a Postgres-backed session is `pses_`, never `ses_`.
 * So routing a call needs no database lookup, just a string check — on the
 * relevant id for anything keyed by one, or on `userId` for the handful of
 * calls (`create`, `listByUser`) that start from scratch. See
 * `pgSessionStore.js`'s header for the full reasoning.
 *
 * @example
 * import { store } from './store/index.js';
 * const session = await store.sessions.create({ userId, subjectId: 'mathematics', … });
 * await store.messages.append({ sessionId: session.id, role: 'user', content: 'hi' });
 */

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { createMemoryStore } from './memory.js';
import { pgSessions, pgSteps, pgMessages, pgPracticeSets, pgMistakes } from './pgSessionStore.js';

/**
 * Builds the memory-only store described by `STORE_DRIVER`. Tests force this
 * (`STORE_DRIVER=memory`) and never touch Postgres, since every id they
 * create is guest-shaped (`usr_…`) — see `tests/helpers.js`.
 *
 * @private
 * @returns {ReturnType<typeof createMemoryStore>}
 */
function createBaseStore() {
  switch (env.STORE_DRIVER) {
    case 'memory':
      if (!env.IS_TEST) {
        logger.warn('Using the in-memory store for guests: their data is lost when the server restarts.');
      }
      return createMemoryStore();

    default:
      throw new Error(`Unknown STORE_DRIVER "${env.STORE_DRIVER}".`);
  }
}

const memoryStore = createBaseStore();

/** A guest's id always starts with this — see `utils/ids.js`'s `newUserId()`. */
const isGuestUserId = (userId) => typeof userId === 'string' && userId.startsWith('usr_');

/** A Postgres-owned record's id always starts with this — see `pgSessionStore.js`. */
const isPostgresId = (id) => typeof id === 'string' && id.startsWith('p');

export const store = {
  /** Unaffected by this file — guest vs signed-in is resolved in `middleware/auth.js`. */
  users: memoryStore.users,

  sessions: {
    create(data) {
      return isGuestUserId(data.userId) ? memoryStore.sessions.create(data) : pgSessions.create(data);
    },
    findById(id, userId) {
      return isPostgresId(id) ? pgSessions.findById(id, userId) : memoryStore.sessions.findById(id, userId);
    },
    listByUser(userId, options) {
      return isGuestUserId(userId) ? memoryStore.sessions.listByUser(userId, options) : pgSessions.listByUser(userId, options);
    },
    update(id, changes) {
      return isPostgresId(id) ? pgSessions.update(id, changes) : memoryStore.sessions.update(id, changes);
    },
    remove(id) {
      return isPostgresId(id) ? pgSessions.remove(id) : memoryStore.sessions.remove(id);
    },
  },

  steps: {
    replaceAll(sessionId, items) {
      return isPostgresId(sessionId) ? pgSteps.replaceAll(sessionId, items) : memoryStore.steps.replaceAll(sessionId, items);
    },
    listBySession(sessionId) {
      return isPostgresId(sessionId) ? pgSteps.listBySession(sessionId) : memoryStore.steps.listBySession(sessionId);
    },
    findById(sessionId, stepId) {
      return isPostgresId(sessionId) ? pgSteps.findById(sessionId, stepId) : memoryStore.steps.findById(sessionId, stepId);
    },
    setStatus(sessionId, index, status) {
      return isPostgresId(sessionId) ? pgSteps.setStatus(sessionId, index, status) : memoryStore.steps.setStatus(sessionId, index, status);
    },
  },

  messages: {
    append(data) {
      return isPostgresId(data.sessionId) ? pgMessages.append(data) : memoryStore.messages.append(data);
    },
    listBySession(sessionId, options) {
      return isPostgresId(sessionId) ? pgMessages.listBySession(sessionId, options) : memoryStore.messages.listBySession(sessionId, options);
    },
  },

  practiceSets: {
    create(data) {
      return isGuestUserId(data.userId) ? memoryStore.practiceSets.create(data) : pgPracticeSets.create(data);
    },
    findById(id, userId) {
      return isPostgresId(id) ? pgPracticeSets.findById(id, userId) : memoryStore.practiceSets.findById(id, userId);
    },
    update(id, changes) {
      return isPostgresId(id) ? pgPracticeSets.update(id, changes) : memoryStore.practiceSets.update(id, changes);
    },
  },

  mistakes: {
    record(data) {
      return isGuestUserId(data.userId) ? memoryStore.mistakes.record(data) : pgMistakes.record(data);
    },
    listByUser(userId, options) {
      return isGuestUserId(userId) ? memoryStore.mistakes.listByUser(userId, options) : pgMistakes.listByUser(userId, options);
    },
  },

  /** Wipes the in-memory half only. Used by tests; never called in production. */
  reset: memoryStore.reset,
};
