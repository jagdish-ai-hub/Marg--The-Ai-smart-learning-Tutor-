/**
 * @file Signed-in accounts — the Postgres half of auth.
 *
 * Guest accounts (see `store/memory.js`) live only in memory and vanish on
 * restart. A signed-in student (via Google, see `controllers/auth.controller.js`
 * `google()`) gets a row here instead, in the same Neon database that backs
 * Managed Better Auth — so their daily message count survives restarts and
 * deploys, which is the entire point of asking them to sign in.
 *
 * This is deliberately a separate, tiny table (`app_users`), not the
 * `neon_auth` schema that Better Auth owns. We only need one thing it doesn't
 * track: the daily message quota. Identity (email, OAuth tokens, sessions)
 * stays Better Auth's problem; this file just keys off the same user id.
 *
 * Unconfigured by default — an app with no `DATABASE_URL` simply never calls
 * `google()`, and guest mode works exactly as before.
 *
 * USES THE HTTP DRIVER, NOT A SOCKET POOL
 * `@neondatabase/serverless`'s `neon()` sends each query as a plain HTTPS
 * request rather than opening a raw Postgres (TCP) connection. That is a
 * deliberate choice, not just a style preference: it is what lets this file
 * work from *any* host, including serverless/edge platforms (and sandboxes)
 * that only allow outbound HTTP(S) and block raw TCP outright. Every query
 * here is a single independent statement, so there is no session state to
 * lose by not holding a persistent connection open.
 *
 * @example
 * import { pgUsers } from './pgUsers.js';
 * const user = await pgUsers.findOrCreate({ id: 'abc-123', email: 'a@b.com' });
 * const count = await pgUsers.incrementDailyMessageCount(user.id);
 */

import { neon } from '@neondatabase/serverless';
import { env } from '../config/env.js';

/** True once both `DATABASE_URL` and `NEON_AUTH_BASE_URL` are set. */
export const isConfigured = Boolean(env.DATABASE_URL && env.NEON_AUTH_BASE_URL);

const sql = isConfigured ? neon(env.DATABASE_URL) : null;

/**
 * @private
 * @returns {ReturnType<typeof neon>} The query function.
 * @throws {Error} If `DATABASE_URL`/`NEON_AUTH_BASE_URL` were never set.
 */
function requireSql() {
  if (!sql) {
    throw new Error(
      'Signed-in accounts are not configured. Set DATABASE_URL and NEON_AUTH_BASE_URL — see .env.example.',
    );
  }
  return sql;
}

/**
 * Maps a database row to the same user shape `store.users` returns, so
 * `requireAuth` and the controllers never need to know which one they got.
 *
 * @private
 * @param {object|undefined} row - A row from `app_users`.
 * @returns {object|null}
 */
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    isGuest: false,
    email: row.email,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

export const pgUsers = {
  /**
   * Finds a signed-in user by id, creating one if this is their first sign-in.
   *
   * @param {object} data
   * @param {string} data.id - The Neon Auth user id (the JWT's `sub` claim).
   * @param {string} data.email - Their email, as Google reported it.
   * @returns {Promise<object>} The user.
   */
  async findOrCreate({ id, email }) {
    const rows = await requireSql().query(
      `INSERT INTO app_users (id, email)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, last_seen_at = now()
       RETURNING *`,
      [id, email],
    );
    return toUser(rows[0]);
  },

  /**
   * Looks up a signed-in user by id.
   *
   * @param {string} id - User id.
   * @returns {Promise<object|null>} The user, or `null` if unknown.
   */
  async findById(id) {
    const rows = await requireSql().query('SELECT * FROM app_users WHERE id = $1', [id]);
    return toUser(rows[0]);
  },

  /**
   * Records that a user just made a request.
   *
   * @param {string} id - User id.
   * @returns {Promise<void>}
   */
  async touch(id) {
    await requireSql().query('UPDATE app_users SET last_seen_at = now() WHERE id = $1', [id]);
  },

  /**
   * Increments today's message count, resetting it first if the stored date
   * is not today. One `UPDATE` so concurrent requests from the same user
   * cannot race past each other — Postgres serialises writes to one row.
   *
   * @param {string} id - User id.
   * @returns {Promise<number>} The count *after* this message — compare it
   *   to `env.SIGNED_IN_DAILY_MESSAGE_LIMIT`.
   */
  async incrementDailyMessageCount(id) {
    const rows = await requireSql().query(
      `UPDATE app_users
       SET daily_message_count = CASE
             WHEN daily_message_count_date = CURRENT_DATE THEN daily_message_count + 1
             ELSE 1
           END,
           daily_message_count_date = CURRENT_DATE
       WHERE id = $1
       RETURNING daily_message_count`,
      [id],
    );
    return rows[0]?.daily_message_count ?? 0;
  },
};
