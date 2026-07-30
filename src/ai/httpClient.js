/**
 * @file Shared HTTP plumbing for talking to AI providers.
 *
 * Every provider needs the same three things — a timeout, cancellation when the
 * student closes the tab, and error messages that say something useful instead
 * of "fetch failed". They live here so each provider file stays focused on the
 * bit that is actually different: the request shape.
 */

import { env } from '../config/env.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';

/**
 * Calls an AI provider over HTTP with a timeout and cancellation support.
 *
 * Two separate things can cancel the request:
 *   - our own timeout (`AI_TIMEOUT_MS`), which becomes a 504
 *   - the caller's signal, i.e. the student closed the tab, which is not an
 *     error at all and is re-thrown untouched so the caller can ignore it
 *
 * @param {string} url - Full URL to call.
 * @param {object} options
 * @param {object} options.body - Request body, serialised to JSON for you.
 * @param {Record<string,string>} [options.headers] - Extra headers to merge in.
 * @param {AbortSignal} [options.signal] - Caller's cancellation signal.
 * @param {string} options.provider - Provider name, used in error messages.
 * @returns {Promise<Response>} The raw `fetch` response, already checked for HTTP errors.
 * @throws {ApiError} `PROVIDER_TIMEOUT` if we ran out of time,
 *   `PROVIDER_UNAVAILABLE` for any non-2xx reply or network failure.
 */
export async function postToProvider(url, { body, headers = {}, signal, provider }) {
  // A dedicated controller so our timeout and the caller's signal stay separable.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), env.AI_TIMEOUT_MS);

  // Node 20+ ships AbortSignal.any, which merges signals cleanly. Older builds
  // fall back to just our timeout plus a manual forward of the caller's signal.
  let combinedSignal;
  if (signal && typeof AbortSignal.any === 'function') {
    combinedSignal = AbortSignal.any([timeoutController.signal, signal]);
  } else {
    combinedSignal = timeoutController.signal;
    signal?.addEventListener('abort', () => timeoutController.abort(), { once: true });
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (error) {
    clearTimeout(timeoutId);

    // The caller cancelled deliberately — let that bubble up as-is so the
    // route can quietly stop instead of reporting a failure to nobody.
    if (signal?.aborted) throw error;

    if (error.name === 'AbortError') {
      throw ApiError.timeout(
        `The AI service (${provider}) did not respond within ${env.AI_TIMEOUT_MS / 1000} seconds.`,
        { provider },
      );
    }
    throw ApiError.provider(
      ErrorCodes.PROVIDER_UNAVAILABLE,
      `Could not reach the AI service (${provider}).`,
      { provider, cause: error.message },
    );
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw ApiError.provider(
      ErrorCodes.PROVIDER_UNAVAILABLE,
      describeHttpFailure(response.status, provider),
      { provider, status: response.status, detail },
    );
  }

  return response;
}

/**
 * Turns an HTTP status into a sentence that actually tells you what to do.
 *
 * @private
 * @param {number} status - HTTP status code from the provider.
 * @param {string} provider - Provider name.
 * @returns {string} A human-readable explanation.
 */
function describeHttpFailure(status, provider) {
  if (status === 401 || status === 403) {
    return `The AI service (${provider}) rejected our API key. Check the key in your .env file.`;
  }
  if (status === 429) {
    return `The AI service (${provider}) is rate limiting us. Try again shortly.`;
  }
  if (status >= 500) {
    return `The AI service (${provider}) is having problems right now.`;
  }
  return `The AI service (${provider}) rejected the request (HTTP ${status}).`;
}

/**
 * Reads an error response body without ever throwing.
 *
 * Truncated because provider error bodies can be enormous, and this ends up in
 * our logs.
 *
 * @private
 * @param {Response} response - The failed response.
 * @returns {Promise<string>} Body text, capped at 500 characters.
 */
async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return '(could not read response body)';
  }
}

/**
 * Reads a Server-Sent Events response body and yields one parsed JSON payload
 * per event.
 *
 * Both Gemini (`?alt=sse`) and OpenAI-style APIs stream in this format, so a
 * single reader serves both. Handles the fiddly part: a chunk from the network
 * can end mid-line, so incomplete lines are buffered until the rest arrives.
 *
 * @param {Response} response - A streaming response.
 * @yields {any} Each event's `data:` payload, parsed from JSON.
 * @returns {AsyncGenerator<any>}
 */
export async function* readSseJson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Keep the last element back: it may be a partial line.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        // OpenAI-style APIs mark the end of the stream with this sentinel.
        if (payload === '[DONE]') return;

        try {
          yield JSON.parse(payload);
        } catch {
          // A malformed event is not worth killing the whole stream over.
        }
      }
    }
  } finally {
    // Releases the socket even if the consumer stops reading early.
    reader.releaseLock?.();
  }
}
