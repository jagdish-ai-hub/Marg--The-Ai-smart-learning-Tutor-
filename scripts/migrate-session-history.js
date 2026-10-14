/**
 * @file One-off migration: creates the tables that hold a signed-in student's
 * session history in Postgres (guests keep living entirely in memory — see
 * src/store/index.js for the routing logic).
 *
 * Run once against the real Neon database:
 *   node scripts/migrate-session-history.js
 *
 * Safe to re-run — every statement is `IF NOT EXISTS`.
 */

import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set — nothing to migrate.');
  process.exit(1);
}

const sql = neon(databaseUrl);

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      title TEXT,
      topic TEXT,
      problem TEXT NOT NULL,
      restated_problem TEXT,
      final_answer TEXT,
      answer_policy TEXT NOT NULL DEFAULT 'on_request',
      answer_revealed BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'active',
      current_step_index INTEGER NOT NULL DEFAULT 1,
      reveal_count INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'guide',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      skill TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_steps_session ON steps (session_id, step_index)`;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mode TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS practice_sets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL,
      subject_id TEXT,
      skill TEXT,
      problems JSONB NOT NULL,
      results JSONB,
      submitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_practice_sets_user ON practice_sets (user_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS mistakes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      subject_id TEXT,
      topic TEXT,
      skill TEXT,
      error_type TEXT,
      error_summary TEXT,
      step_index INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_mistakes_user ON mistakes (user_id, created_at DESC)`;

  console.log('Session-history tables are ready.');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
