/**
 * @file Generates the short prefixed ids used throughout the API.
 *
 * Ids look like `ses_k3f9a2xq10z8` — a short prefix saying what kind of thing
 * it is, then random characters. The prefix is genuinely useful: when you see
 * an id in a log line or a bug report you immediately know whether it is a
 * session, a message, or a step, with nothing else to look up.
 *
 * @example
 * newId('ses');            // 'ses_lm2p9q4v7t1a'
 * newSessionId();          // same thing, but you cannot typo the prefix
 */

import { randomUUID } from 'node:crypto';

/**
 * Creates a random id with the given prefix.
 *
 * Not cryptographically meaningful — do not use these as secrets or tokens.
 * They only need to be unique, and a UUID's worth of randomness is far more
 * than enough for that.
 *
 * @param {string} prefix - Short kind marker, e.g. `'ses'`.
 * @returns {string} An id shaped like `prefix_xxxxxxxxxxxx`.
 */
export function newId(prefix) {
  const random = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${random}`;
}

/** @returns {string} A new user id, e.g. `usr_a1b2c3d4e5f6`. */
export const newUserId = () => newId('usr');

/** @returns {string} A new session id, e.g. `ses_a1b2c3d4e5f6`. */
export const newSessionId = () => newId('ses');

/** @returns {string} A new message id, e.g. `msg_a1b2c3d4e5f6`. */
export const newMessageId = () => newId('msg');

/** @returns {string} A new step id, e.g. `stp_a1b2c3d4e5f6`. */
export const newStepId = () => newId('stp');

/** @returns {string} A new practice-set id, e.g. `set_a1b2c3d4e5f6`. */
export const newPracticeSetId = () => newId('set');

/** @returns {string} A new mistake-log entry id, e.g. `mst_a1b2c3d4e5f6`. */
export const newMistakeId = () => newId('mst');

/** @returns {string} A new request id, e.g. `req_a1b2c3d4e5f6`. */
export const newRequestId = () => newId('req');
