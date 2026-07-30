/**
 * @file A very small logger. No dependencies on purpose.
 *
 * Log lines go to stdout as JSON in production (easy for hosting platforms to
 * index) and as readable coloured text in development (easy for humans).
 *
 * @example
 * logger.info('session created', { sessionId: 'ses_abc', subject: 'mathematics' });
 * logger.error('provider failed', { provider: 'gemini', status: 429 });
 */

import { env } from '../config/env.js';

/** Numeric ranking so we can filter anything below the active level. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** ANSI colour codes for pretty development output. */
const COLOURS = {
  debug: '\x1b[90m', // grey
  info: '\x1b[36m',  // cyan
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
};

// Tests only care about failures; everything else is noise in the test output.
const activeLevel = env.IS_TEST ? LEVELS.error : LEVELS.debug;

/**
 * Writes one log line.
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Severity.
 * @param {string} message - Short human-readable description.
 * @param {object} [context] - Extra structured fields, e.g. `{ userId, sessionId }`.
 * @returns {void}
 */
function write(level, message, context = {}) {
  if (LEVELS[level] < activeLevel) return;

  const timestamp = new Date().toISOString();

  if (env.IS_PRODUCTION) {
    // One JSON object per line — the format log aggregators expect.
    process.stdout.write(`${JSON.stringify({ timestamp, level, message, ...context })}\n`);
    return;
  }

  const colour = COLOURS[level] ?? '';
  const extras = Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  process.stdout.write(
    `${colour}${timestamp} ${level.toUpperCase().padEnd(5)}${COLOURS.reset} ${message}${extras}\n`,
  );
}

/**
 * The application logger.
 *
 * @type {{
 *   debug: (message: string, context?: object) => void,
 *   info:  (message: string, context?: object) => void,
 *   warn:  (message: string, context?: object) => void,
 *   error: (message: string, context?: object) => void
 * }}
 */
export const logger = {
  /** Fine-grained detail useful while developing. Hidden in tests. */
  debug: (message, context) => write('debug', message, context),
  /** Normal, expected events worth recording. */
  info: (message, context) => write('info', message, context),
  /** Something looks wrong but the request still succeeded. */
  warn: (message, context) => write('warn', message, context),
  /** Something failed. */
  error: (message, context) => write('error', message, context),
};
