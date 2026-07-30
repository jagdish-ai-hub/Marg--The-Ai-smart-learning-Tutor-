/**
 * @file Builds the Express application.
 *
 * Exported as a function rather than a ready-made app so tests can create an
 * instance without starting a server or binding a port. `src/server.js` is the
 * only thing that actually listens.
 *
 * MIDDLEWARE ORDER MATTERS. Each layer below depends on the one above it:
 *   1. helmet       — security headers, before anything can respond
 *   2. cors         — must run before routes, or the browser blocks the reply
 *   3. json parser  — populates req.body
 *   4. requestId    — adds req.id and res.ok(), used by everything after
 *   5. routes       — the actual endpoints
 *   6. notFound     — anything that matched no route
 *   7. errorHandler — must be last; Express only sends errors here
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import routes from './routes/index.js';
import { requestId } from './middleware/requestId.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { env } from './config/env.js';

/**
 * Builds the CORS settings from `CORS_ORIGINS`.
 *
 * @private
 * @returns {object} Options for the `cors` middleware.
 */
function buildCorsOptions() {
  // "*" means allow everything — fine locally, and exactly what you do not want
  // in production, which is why it has to be set deliberately.
  if (env.CORS_ORIGINS.includes('*')) {
    return { origin: true, credentials: false };
  }

  return {
    /**
     * @param {string|undefined} origin - The requesting origin. Undefined for
     *   same-origin requests and for tools like curl, which send no Origin header.
     * @param {(error: Error|null, allowed?: boolean) => void} callback - CORS callback.
     */
    origin(origin, callback) {
      if (!origin || env.CORS_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
    credentials: false,
    // Lets the frontend read the request id off a response for bug reports.
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining'],
  };
}

/**
 * Creates the Express app with all middleware and routes wired up.
 *
 * @returns {import('express').Express} The configured app.
 *
 * @example
 * // In a test:
 * const app = createApp();
 * const server = app.listen(0); // port 0 = pick any free port
 */
export function createApp() {
  const app = express();

  // Behind a load balancer, this makes req.ip the real client address rather
  // than the proxy's — which matters because rate limiting counts by it.
  app.set('trust proxy', 1);
  // Removes the "X-Powered-By: Express" header. Free information for nobody.
  app.disable('x-powered-by');

  app.use(helmet({
    // This is a JSON API with no HTML, so CSP has nothing to protect and only
    // gets in the way of tools like Swagger UI added later.
    contentSecurityPolicy: false,
  }));
  app.use(cors(buildCorsOptions()));

  // 5 MB covers a long pasted attempt with room to spare. Photos go through
  // multipart upload instead, which has its own separate limit.
  app.use(express.json({ limit: '5mb' }));

  app.use(requestId);

  /**
   * A friendly root response, so hitting the bare URL in a browser tells you
   * what this is rather than returning a bare 404.
   */
  app.get('/', (req, res) => {
    res.ok({
      name: 'Marg API',
      description: 'Backend for Marg — an AI tutor that shows its work.',
      version: 'v1',
      docs: 'See docs/API.md and docs/FRONTEND-GUIDE.md in the repository.',
      health: '/health',
      apiRoot: '/api/v1',
    });
  });

  app.use(routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
