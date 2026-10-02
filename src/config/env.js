/**
 * @file Reads and validates every environment variable the app needs.
 *
 * WHY THIS FILE EXISTS
 * Reading `process.env.SOMETHING` all over the codebase is a common source of
 * bugs: a typo gives you `undefined`, and you only find out when a request
 * fails at 2am. Instead, everything is read *once*, right here, checked, and
 * exported as a plain frozen object.
 *
 * If something required is missing or nonsensical, the process exits
 * immediately with a message naming the exact variable — before it ever
 * accepts a request.
 *
 * @example
 * import { env } from './config/env.js';
 * console.log(env.PORT);          // 4000  (a number, not the string "4000")
 * console.log(env.CORS_ORIGINS);  // ['http://localhost:5173']
 */

import dotenv from 'dotenv';

// Load a .env file into process.env if one exists. Real environment variables
// (the ones set by your hosting provider) always win over the file.
dotenv.config();

/** Provider names this app knows how to talk to. */
const VALID_PROVIDERS = ['gemini', 'openrouter', 'openai-compatible', 'mock'];

/** Answer-reveal policies. See docs/TUTORING-MODEL.md. */
const VALID_ANSWER_POLICIES = ['never', 'on_request', 'after_attempt'];

/** Storage drivers. Only in-memory exists today; 'turso' is the planned next one. */
const VALID_STORE_DRIVERS = ['memory'];

/** Collected problems, so we can report *all* of them at once instead of one per run. */
const problems = [];

/**
 * Reads a plain string variable.
 *
 * @param {string} name - The environment variable name, e.g. `'JWT_SECRET'`.
 * @param {object} [options]
 * @param {string} [options.fallback] - Value to use when the variable is unset.
 * @param {boolean} [options.required=false] - If true, record a problem when it is missing.
 * @returns {string} The value, or the fallback, or `''`.
 */
function readString(name, { fallback = '', required = false } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : raw;
  if (required && !value) {
    problems.push(`${name} is required but was not set.`);
  }
  return value;
}

/**
 * Reads a variable that must be a number.
 *
 * @param {string} name - The environment variable name.
 * @param {number} fallback - Value to use when unset.
 * @returns {number} The parsed number, or the fallback if unset/invalid.
 */
function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    problems.push(`${name} must be a number, but got "${raw}".`);
    return fallback;
  }
  return parsed;
}

/**
 * Reads a true/false variable. Accepts `true`, `1`, `yes`, `on` (case-insensitive).
 *
 * @param {string} name - The environment variable name.
 * @param {boolean} fallback - Value to use when unset.
 * @returns {boolean}
 */
function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Reads a comma-separated list, e.g. `"a.com, b.com"` becomes `['a.com', 'b.com']`.
 * Blank entries and surrounding whitespace are dropped.
 *
 * @param {string} name - The environment variable name.
 * @param {string} fallback - Comma-separated default.
 * @returns {string[]}
 */
function readList(name, fallback) {
  const raw = readString(name, { fallback });
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Reads a variable that must be one of a fixed set of values.
 *
 * @param {string} name - The environment variable name.
 * @param {string[]} allowed - The permitted values.
 * @param {string} fallback - Value to use when unset.
 * @returns {string}
 */
function readEnum(name, allowed, fallback) {
  const value = readString(name, { fallback });
  if (!allowed.includes(value)) {
    problems.push(`${name} must be one of: ${allowed.join(', ')} — but got "${value}".`);
    return fallback;
  }
  return value;
}

const NODE_ENV = readEnum('NODE_ENV', ['development', 'production', 'test'], 'development');
const isTest = NODE_ENV === 'test';
const isProduction = NODE_ENV === 'production';

const AI_PROVIDER = readEnum('AI_PROVIDER', VALID_PROVIDERS, 'mock');

// The fallback provider is optional, so '' is allowed alongside the real names.
const AI_FALLBACK_PROVIDER = readEnum('AI_FALLBACK_PROVIDER', [...VALID_PROVIDERS, ''], '');

const GEMINI_API_KEY = readString('GEMINI_API_KEY');
const OPENROUTER_API_KEY = readString('OPENROUTER_API_KEY');
const OPENAI_COMPATIBLE_API_KEY = readString('OPENAI_COMPATIBLE_API_KEY');
const OPENAI_COMPATIBLE_BASE_URL = readString('OPENAI_COMPATIBLE_BASE_URL');

/**
 * Checks that a chosen provider actually has the credentials it needs.
 * Catches the single most common setup mistake: `AI_PROVIDER=gemini` with an
 * empty `GEMINI_API_KEY`.
 *
 * @param {string} provider - Provider name to check.
 * @param {string} label - Which setting selected it, used in the error message.
 * @returns {void}
 */
function requireProviderCredentials(provider, label) {
  if (provider === 'gemini' && !GEMINI_API_KEY) {
    problems.push(`${label}=gemini, so GEMINI_API_KEY must be set. Get a free key at https://aistudio.google.com/apikey`);
  }
  if (provider === 'openrouter' && !OPENROUTER_API_KEY) {
    problems.push(`${label}=openrouter, so OPENROUTER_API_KEY must be set. Get one at https://openrouter.ai/keys`);
  }
  if (provider === 'openai-compatible') {
    if (!OPENAI_COMPATIBLE_BASE_URL) {
      problems.push(`${label}=openai-compatible, so OPENAI_COMPATIBLE_BASE_URL must be set (e.g. https://api.groq.com/openai/v1).`);
    }
    if (!OPENAI_COMPATIBLE_API_KEY) {
      problems.push(`${label}=openai-compatible, so OPENAI_COMPATIBLE_API_KEY must be set.`);
    }
  }
}

// Tests always run against the mock provider, so credential checks are skipped.
if (!isTest) {
  requireProviderCredentials(AI_PROVIDER, 'AI_PROVIDER');
  if (AI_FALLBACK_PROVIDER) {
    requireProviderCredentials(AI_FALLBACK_PROVIDER, 'AI_FALLBACK_PROVIDER');
  }
}

const JWT_SECRET = readString('JWT_SECRET', {
  fallback: isTest ? 'test-secret-not-for-production' : '',
  required: !isTest,
});

// A default secret left in place on a public server means anyone can mint
// tokens for any user. Block it in production specifically.
if (isProduction && JWT_SECRET === 'change-me-to-a-long-random-string') {
  problems.push('JWT_SECRET is still the example value. Set a real random secret before deploying.');
}

const CORS_ORIGINS = readList('CORS_ORIGINS', 'http://localhost:5173,http://localhost:3000');

/**
 * The validated configuration for the whole application.
 *
 * @type {Readonly<{
 *   PORT: number, NODE_ENV: string, IS_PRODUCTION: boolean, IS_TEST: boolean,
 *   CORS_ORIGINS: string[], JWT_SECRET: string, JWT_TTL: string,
 *   AI_PROVIDER: string, AI_FALLBACK_PROVIDER: string, AI_MODEL_FAST: string,
 *   AI_TIMEOUT_MS: number, GEMINI_API_KEY: string, GEMINI_MODEL: string,
 *   OPENROUTER_API_KEY: string, OPENROUTER_BASE_URL: string, OPENROUTER_MODEL: string,
 *   OPENAI_COMPATIBLE_API_KEY: string, OPENAI_COMPATIBLE_BASE_URL: string,
 *   OPENAI_COMPATIBLE_MODEL: string, STORE_DRIVER: string, STRICT_SCOPE: boolean,
 *   DEFAULT_ANSWER_POLICY: string, RATE_LIMIT_AI_PER_MIN: number,
 *   RATE_LIMIT_GENERAL_PER_MIN: number, MAX_UPLOAD_MB: number
 * }>}
 */
export const env = Object.freeze({
  // Server
  PORT: readNumber('PORT', 4000),
  NODE_ENV,
  IS_PRODUCTION: isProduction,
  IS_TEST: isTest,
  CORS_ORIGINS,

  // Auth
  JWT_SECRET,
  JWT_TTL: readString('JWT_TTL', { fallback: '30d' }),

  // AI
  AI_PROVIDER,
  AI_FALLBACK_PROVIDER,
  AI_MODEL_FAST: readString('AI_MODEL_FAST'),
  AI_TIMEOUT_MS: readNumber('AI_TIMEOUT_MS', 60_000),

  GEMINI_API_KEY,
  // gemini-2.5-flash is no longer available to new Google AI Studio accounts
  // (confirmed live: it 404s with a message pointing at a newer model).
  // gemini-3.5-flash-lite is the verified-working default — see docs/ARCHITECTURE.md.
  GEMINI_MODEL: readString('GEMINI_MODEL', { fallback: 'gemini-3.5-flash-lite' }),

  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL: readString('OPENROUTER_BASE_URL', { fallback: 'https://openrouter.ai/api/v1' }),
  OPENROUTER_MODEL: readString('OPENROUTER_MODEL', { fallback: 'google/gemini-3.5-flash-lite' }),

  OPENAI_COMPATIBLE_API_KEY,
  OPENAI_COMPATIBLE_BASE_URL,
  OPENAI_COMPATIBLE_MODEL: readString('OPENAI_COMPATIBLE_MODEL'),

  // Storage
  STORE_DRIVER: readEnum('STORE_DRIVER', VALID_STORE_DRIVERS, 'memory'),

  // Tutoring behaviour
  STRICT_SCOPE: readBoolean('STRICT_SCOPE', true),
  DEFAULT_ANSWER_POLICY: readEnum('DEFAULT_ANSWER_POLICY', VALID_ANSWER_POLICIES, 'on_request'),

  // Limits
  RATE_LIMIT_AI_PER_MIN: readNumber('RATE_LIMIT_AI_PER_MIN', 20),
  RATE_LIMIT_GENERAL_PER_MIN: readNumber('RATE_LIMIT_GENERAL_PER_MIN', 120),
  MAX_UPLOAD_MB: readNumber('MAX_UPLOAD_MB', 8),
});

/**
 * Stops the process if any variable failed validation, printing every problem
 * at once so you can fix your `.env` in a single pass.
 *
 * Called by `src/server.js` at startup. Tests import `createApp()` directly and
 * never call this, which is why it is a separate exported function rather than
 * running automatically when this module loads.
 *
 * @returns {void}
 * @throws Never returns if configuration is invalid — calls `process.exit(1)`.
 */
export function assertEnvIsValid() {
  if (problems.length === 0) return;

  console.error('\n  Marg cannot start — there are problems with your configuration:\n');
  for (const problem of problems) {
    console.error(`   • ${problem}`);
  }
  console.error('\n  Fix these in your .env file (copy .env.example if you have not yet).');
  console.error('  Tip: set AI_PROVIDER=mock to run with no API key at all.\n');
  process.exit(1);
}

/**
 * The list of validation problems found. Exposed for tests and for the
 * `/health/ready` endpoint.
 *
 * @returns {string[]} A copy of the problem list (empty when config is valid).
 */
export function getEnvProblems() {
  return [...problems];
}
