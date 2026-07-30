/**
 * @file Starts the server. The entry point for `npm start` and `npm run dev`.
 *
 * Everything interesting happens elsewhere — this file validates the config,
 * opens a port, prints something useful, and shuts down cleanly.
 */

import { createApp } from './app.js';
import { env, assertEnvIsValid } from './config/env.js';
import { logger } from './utils/logger.js';
import { describeProviders } from './ai/registry.js';

// Check the configuration before doing anything else. If something is wrong,
// this exits with a message naming the exact variable — far better than
// starting successfully and failing on the first real request.
assertEnvIsValid();

const app = createApp();

const server = app.listen(env.PORT, () => {
  const providers = describeProviders();

  logger.info('Marg API is running', {
    url: `http://localhost:${env.PORT}`,
    environment: env.NODE_ENV,
    aiProvider: providers.active,
    fallbackProvider: providers.fallback,
    store: env.STORE_DRIVER,
    strictScope: env.STRICT_SCOPE,
  });

  if (providers.active === 'mock') {
    logger.info('Running with the mock AI provider — replies are canned. Set AI_PROVIDER in .env to use a real model.');
  }
});

/**
 * Shuts down without cutting off requests that are already in flight.
 *
 * Hosting platforms send SIGTERM and then wait a few seconds before killing the
 * process. Using that window to finish open requests is the difference between
 * a clean deploy and a handful of students seeing an error mid-question.
 *
 * @param {string} signal - The signal received, e.g. `'SIGTERM'`.
 * @returns {void}
 */
function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);

  server.close(() => {
    logger.info('Closed cleanly');
    process.exit(0);
  });

  // If something is stuck — a long-lived SSE stream, say — do not hang forever.
  setTimeout(() => {
    logger.warn('Shutdown timed out, exiting anyway');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A promise rejection nobody caught means the app is in an unknown state.
// Log it loudly rather than letting Node exit silently on it.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
