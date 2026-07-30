/**
 * @file The single door to stored data.
 *
 * Nothing outside this folder knows *how* data is stored. Services import
 * `store` and call `store.sessions.findById(...)`; whether that hits a `Map`,
 * SQLite, or Postgres is decided here and nowhere else.
 *
 * That indirection is the entire reason moving to Turso later is a small job:
 * write `turso.js` implementing the same repositories, add a case to the switch
 * below, and change one line of `.env`. See docs/ARCHITECTURE.md.
 *
 * @example
 * import { store } from '../store/index.js';
 * const user = await store.users.create();
 */

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { createMemoryStore } from './memory.js';

/**
 * Builds the store described by `STORE_DRIVER`.
 *
 * @private
 * @returns {object} A store instance.
 * @throws {Error} If the driver name is not recognised.
 */
function createStore() {
  switch (env.STORE_DRIVER) {
    case 'memory':
      // Only warn outside tests — the test suite always uses memory on purpose.
      if (!env.IS_TEST) {
        logger.warn('Using the in-memory store: all data is lost when the server restarts.');
      }
      return createMemoryStore();

    // Next driver to add. See docs/ARCHITECTURE.md for the full checklist.
    // case 'turso':
    //   return createTursoStore();

    default:
      throw new Error(`Unknown STORE_DRIVER "${env.STORE_DRIVER}".`);
  }
}

/**
 * The application's store.
 *
 * @type {ReturnType<typeof createMemoryStore>}
 */
export const store = createStore();
