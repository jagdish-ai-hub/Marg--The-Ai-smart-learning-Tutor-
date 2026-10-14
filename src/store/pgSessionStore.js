/**
 * @file Session history for signed-in students — the Postgres half of the
 * store, alongside `pgUsers.js` (accounts) and `memory.js` (guests).
 *
 * Implements the exact same shape as `memory.js`'s `sessions`/`steps`/
 * `messages`/`practiceSets`/`mistakes` repositories, field for field — see
 * `store/index.js`, which routes each call to this file or to the in-memory
 * one, and every service in `src/services/` that neither knows nor cares
 * which one answered.
 *
 * WHY SIGNED-IN STUDENTS GET THIS AND GUESTS DON'T
 * A guest's work is meant to be a free taste — see `middleware/quota.js`.
 * Losing it on a restart is an acceptable (and honestly, barely noticed)
 * cost of that. A signed-in student is a different promise: they made an
 * account specifically so their history sticks around, so their sessions
 * live here instead, in the same Neon database as their account.
 *
 * IDS CARRY THE BACKEND, NOT JUST THE KIND
 * `utils/ids.js` already prefixes every id by kind (`ses_`, `msg_`, …) so a
 * log line says what something is at a glance. This file extends that same
 * idea one step further: its ids are prefixed `pses_`, `pmsg_`, `pstp_`,
 * `pset_`, `pmst_` — the leading `p` for "Postgres" — which is what lets
 * `store/index.js` route a call like `messages.append({ sessionId, … })`
 * correctly with nothing more than a string check on `sessionId`, no lookup
 * required.
 *
 * Uses the HTTP driver (`@neondatabase/serverless`'s `neon()`), not a raw
 * socket, for the same reason `pgUsers.js` does — see that file's header.
 */

import { neon } from '@neondatabase/serverless';
import { env } from '../config/env.js';
import { newId } from '../utils/ids.js';

/** True once `DATABASE_URL` is set — same gate `pgUsers.js` uses. */
export const isConfigured = Boolean(env.DATABASE_URL);

const sql = isConfigured ? neon(env.DATABASE_URL) : null;

/**
 * @private
 * @returns {ReturnType<typeof neon>}
 * @throws {Error} If `DATABASE_URL` was never set.
 */
function requireSql() {
  if (!sql) {
    throw new Error('Postgres session history is not configured. Set DATABASE_URL — see .env.example.');
  }
  return sql;
}

// --- Row -> app-shape mappers -----------------------------------------------
// Keep the public shape identical to memory.js, so no consumer can tell which
// backend answered.

function toSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    subjectId: row.subject_id,
    title: row.title,
    topic: row.topic,
    problem: row.problem,
    restatedProblem: row.restated_problem,
    finalAnswer: row.final_answer,
    answerPolicy: row.answer_policy,
    answerRevealed: row.answer_revealed,
    status: row.status,
    currentStepIndex: row.current_step_index,
    revealCount: row.reveal_count,
    attemptCount: row.attempt_count,
    mode: row.mode,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    index: row.step_index,
    instruction: row.instruction,
    skill: row.skill,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function toMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    mode: row.mode,
    meta: row.meta ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

function toPracticeSet(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    subjectId: row.subject_id,
    skill: row.skill,
    problems: row.problems,
    results: row.results,
    submittedAt: row.submitted_at ? row.submitted_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function toMistake(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    subjectId: row.subject_id,
    topic: row.topic,
    skill: row.skill,
    errorType: row.error_type,
    errorSummary: row.error_summary,
    stepIndex: row.step_index,
    createdAt: row.created_at.toISOString(),
  };
}

export const pgSessions = {
  async create(data) {
    const rows = await requireSql().query(
      `INSERT INTO sessions
         (id, user_id, subject_id, title, topic, problem, restated_problem,
          final_answer, answer_policy, answer_revealed, status,
          current_step_index, reveal_count, attempt_count, mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, 'active', 1, 0, 0, 'guide')
       RETURNING *`,
      [
        newId('pses'), data.userId, data.subjectId, data.title ?? null, data.topic ?? null,
        data.problem, data.restatedProblem ?? null, data.finalAnswer ?? null,
        data.answerPolicy ?? 'on_request',
      ],
    );
    return toSession(rows[0]);
  },

  async findById(id, userId) {
    const rows = await requireSql().query(
      'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return toSession(rows[0]);
  },

  async listByUser(userId, { limit = 20, offset = 0 } = {}) {
    const rows = await requireSql().query(
      'SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset],
    );
    const [{ count }] = await requireSql().query(
      'SELECT count(*)::int AS count FROM sessions WHERE user_id = $1',
      [userId],
    );
    return { items: rows.map(toSession), total: count };
  },

  async update(id, changes) {
    const fields = {
      title: 'title', topic: 'topic', status: 'status', mode: 'mode',
      answerRevealed: 'answer_revealed', currentStepIndex: 'current_step_index',
      revealCount: 'reveal_count', attemptCount: 'attempt_count',
    };
    const sets = [];
    const values = [];
    for (const [jsKey, column] of Object.entries(fields)) {
      if (!(jsKey in changes)) continue;
      values.push(changes[jsKey]);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) {
      const rows = await requireSql().query('SELECT * FROM sessions WHERE id = $1', [id]);
      return toSession(rows[0]);
    }
    values.push(id);
    const rows = await requireSql().query(
      `UPDATE sessions SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return toSession(rows[0]);
  },

  async remove(id) {
    const rows = await requireSql().query('DELETE FROM sessions WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  },
};

export const pgSteps = {
  async replaceAll(sessionId, items) {
    await requireSql().query('DELETE FROM steps WHERE session_id = $1', [sessionId]);
    const created = [];
    for (const [position, item] of items.entries()) {
      const rows = await requireSql().query(
        `INSERT INTO steps (id, session_id, step_index, instruction, skill, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [newId('pstp'), sessionId, position + 1, item.instruction, item.skill, position === 0 ? 'active' : 'pending'],
      );
      created.push(toStep(rows[0]));
    }
    return created;
  },

  async listBySession(sessionId) {
    const rows = await requireSql().query(
      'SELECT * FROM steps WHERE session_id = $1 ORDER BY step_index',
      [sessionId],
    );
    return rows.map(toStep);
  },

  async findById(sessionId, stepId) {
    const rows = await requireSql().query(
      'SELECT * FROM steps WHERE session_id = $1 AND id = $2',
      [sessionId, stepId],
    );
    return toStep(rows[0]);
  },

  async setStatus(sessionId, index, status) {
    const rows = await requireSql().query(
      'UPDATE steps SET status = $1 WHERE session_id = $2 AND step_index = $3 RETURNING *',
      [status, sessionId, index],
    );
    return toStep(rows[0]);
  },
};

export const pgMessages = {
  async append(data) {
    const rows = await requireSql().query(
      `INSERT INTO messages (id, session_id, role, content, mode, meta)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [newId('pmsg'), data.sessionId, data.role, data.content, data.mode ?? null, JSON.stringify(data.meta ?? {})],
    );
    return toMessage(rows[0]);
  },

  async listBySession(sessionId, { limit } = {}) {
    const rows = limit
      ? await requireSql().query(
        'SELECT * FROM (SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2) sub ORDER BY created_at',
        [sessionId, limit],
      )
      : await requireSql().query(
        'SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at',
        [sessionId],
      );
    return rows.map(toMessage);
  },
};

export const pgPracticeSets = {
  async create(data) {
    const rows = await requireSql().query(
      `INSERT INTO practice_sets (id, user_id, session_id, subject_id, skill, problems)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [newId('pset'), data.userId, data.sessionId ?? null, data.subjectId ?? null, data.skill ?? null, JSON.stringify(data.problems)],
    );
    return toPracticeSet(rows[0]);
  },

  async findById(id, userId) {
    const rows = await requireSql().query(
      'SELECT * FROM practice_sets WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return toPracticeSet(rows[0]);
  },

  async update(id, changes) {
    const sets = [];
    const values = [];
    if ('submittedAt' in changes) { values.push(changes.submittedAt); sets.push(`submitted_at = $${values.length}`); }
    if ('results' in changes) { values.push(JSON.stringify(changes.results)); sets.push(`results = $${values.length}`); }
    if (sets.length === 0) {
      const rows = await requireSql().query('SELECT * FROM practice_sets WHERE id = $1', [id]);
      return toPracticeSet(rows[0]);
    }
    values.push(id);
    const rows = await requireSql().query(
      `UPDATE practice_sets SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return toPracticeSet(rows[0]);
  },
};

export const pgMistakes = {
  async record(data) {
    const rows = await requireSql().query(
      `INSERT INTO mistakes
         (id, user_id, session_id, subject_id, topic, skill, error_type, error_summary, step_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        newId('pmst'), data.userId, data.sessionId ?? null, data.subjectId ?? null, data.topic ?? null,
        data.skill ?? null, data.errorType ?? null, data.errorSummary ?? null, data.stepIndex ?? null,
      ],
    );
    return toMistake(rows[0]);
  },

  async listByUser(userId, { since } = {}) {
    const rows = since
      ? await requireSql().query(
        'SELECT * FROM mistakes WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at DESC',
        [userId, since],
      )
      : await requireSql().query(
        'SELECT * FROM mistakes WHERE user_id = $1 ORDER BY created_at DESC',
        [userId],
      );
    return rows.map(toMistake);
  },
};
