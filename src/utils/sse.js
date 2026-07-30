/**
 * @file Helpers for Server-Sent Events (SSE) — how Marg streams a reply to the
 * browser word by word instead of making the student wait for the whole answer.
 *
 * WHAT IS SSE?
 * A normal HTTP response sends everything at once and closes. SSE keeps the
 * connection open and pushes small text chunks as they become available. The
 * browser reads them with the built-in `EventSource` class. It is one-way
 * (server to browser) and far simpler than WebSockets, which is all we need.
 *
 * THE WIRE FORMAT
 * Each event is two lines and a blank line:
 *
 *   event: delta
 *   data: {"text":"because you divided "}
 *   <blank line>
 *
 * The blank line is what tells the browser "that event is complete". Forget it
 * and the client hangs forever, which is the classic SSE bug.
 *
 * @example
 * const stream = new SseStream(req, res);
 * stream.send('start', { messageId: 'msg_abc' });
 * stream.send('delta', { text: 'Hello' });
 * stream.send('done',  { messageId: 'msg_abc' });
 * stream.close();
 */

import { logger } from './logger.js';

/** How often to send a keep-alive comment, in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Wraps an Express response as an SSE stream.
 *
 * Handles the three things people usually get wrong:
 *   1. The headers that stop proxies from buffering the response.
 *   2. A periodic heartbeat so idle connections are not dropped.
 *   3. Detecting when the student closes the tab, so we can abort the
 *      (expensive) AI request instead of paying for tokens nobody will read.
 */
export class SseStream {
  /**
   * Opens the stream and immediately writes the SSE headers.
   *
   * @param {import('express').Request} req - The incoming request. Used to detect disconnects.
   * @param {import('express').Response} res - The response to stream through.
   */
  constructor(req, res) {
    this.req = req;
    this.res = res;
    this.closed = false;

    /**
     * Signals cancellation when the client disconnects. Pass
     * `stream.abortSignal` to the AI provider so the upstream request is
     * cancelled too.
     *
     * @type {AbortController}
     */
    this.abortController = new AbortController();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells nginx not to buffer. Without this you get the whole response in
      // one lump at the end, which defeats the entire point of streaming.
      'X-Accel-Buffering': 'no',
    });
    // Push the headers out now so the browser opens the connection right away.
    res.flushHeaders?.();

    this.heartbeat = setInterval(() => {
      // A line starting with ':' is an SSE comment. Clients ignore it, but it
      // keeps the TCP connection and any proxy timeouts alive.
      if (!this.closed) this.res.write(': heartbeat\n\n');
    }, HEARTBEAT_INTERVAL_MS);
    // Do not let the heartbeat timer keep the Node process alive on shutdown.
    this.heartbeat.unref?.();

    req.on('close', () => {
      if (this.closed) return;
      logger.debug('SSE client disconnected, aborting upstream work');
      this.abortController.abort();
      this.cleanup();
    });
  }

  /**
   * Convenience accessor for the cancellation signal.
   *
   * @returns {AbortSignal} Pass this to `fetch` or an AI provider call.
   */
  get abortSignal() {
    return this.abortController.signal;
  }

  /**
   * Sends one named event with a JSON payload.
   *
   * @param {string} event - Event name: `start`, `delta`, `step`, `done`, or `error`.
   * @param {object} data - Payload. Serialised to JSON automatically.
   * @returns {void}
   *
   * @example
   * stream.send('delta', { text: 'because you ' });
   */
  send(event, data) {
    if (this.closed) return;
    // JSON.stringify never emits a raw newline inside a string, so the payload
    // is always safe to put on a single `data:` line.
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Sends an `error` event using the same shape as a normal JSON error, so the
   * frontend can reuse its error-handling code.
   *
   * @param {string} code - A value from {@link import('./ApiError.js').ErrorCodes}.
   * @param {string} message - Human-readable explanation.
   * @param {object} [details] - Extra context.
   * @returns {void}
   */
  sendError(code, message, details) {
    this.send('error', { code, message, ...(details ? { details } : {}) });
  }

  /**
   * Ends the stream and releases the heartbeat timer.
   *
   * Safe to call more than once — later calls do nothing.
   *
   * @returns {void}
   */
  close() {
    if (this.closed) return;
    this.cleanup();
    this.res.end();
  }

  /**
   * Marks the stream closed and stops the heartbeat. Internal.
   *
   * @private
   * @returns {void}
   */
  cleanup() {
    this.closed = true;
    clearInterval(this.heartbeat);
  }
}

/**
 * Splits a long string into small chunks so the mock provider (and any
 * non-streaming provider) can still *look* like it is streaming.
 *
 * Splits on word boundaries so words never appear cut in half mid-render.
 *
 * @param {string} text - The full text to chunk.
 * @param {number} [size=4] - Roughly how many words per chunk.
 * @returns {string[]} The chunks. Joining them reproduces `text` exactly.
 *
 * @example
 * chunkText('one two three four five', 2); // ['one two ', 'three four ', 'five']
 */
export function chunkText(text, size = 4) {
  // The capture group keeps the whitespace, so joining restores the original.
  const parts = text.split(/(\s+)/);
  const chunks = [];
  let current = '';
  let words = 0;

  for (const part of parts) {
    current += part;
    if (part.trim()) words += 1;
    if (words >= size) {
      chunks.push(current);
      current = '';
      words = 0;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
