/**
 * @file Shared setup for the test suite.
 *
 * Every test boots a real server on a random free port and talks to it over
 * HTTP. Slightly slower than calling controllers directly, but it exercises the
 * middleware, routing, validation, and serialisation as well — which is where
 * most real bugs live.
 *
 * Nothing here touches the network beyond localhost: `AI_PROVIDER=mock` is
 * forced below, so the suite runs offline and gives the same result every time.
 */

// Must be set before anything imports config/env.js, since that reads
// process.env once at module load.
process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'mock';
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.STORE_DRIVER = 'memory';

const { createApp } = await import('../src/app.js');

/**
 * Starts a test server on a free port.
 *
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>}
 *   The server's base URL and a function to shut it down.
 *
 * @example
 * const server = await startTestServer();
 * after(() => server.close());
 */
export async function startTestServer() {
  const app = createApp();

  // Port 0 tells the OS to pick any free port, so test files can run in
  // parallel without fighting over 4000.
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Makes an HTTP request and parses the JSON response.
 *
 * @param {string} baseUrl - The server's base URL.
 * @param {string} path - Path to call, e.g. `'/api/v1/subjects'`.
 * @param {object} [options]
 * @param {string} [options.method='GET'] - HTTP method.
 * @param {object} [options.body] - Request body, serialised to JSON.
 * @param {string} [options.token] - Bearer token.
 * @returns {Promise<{status: number, body: any}>} Status and parsed body.
 */
export async function request(baseUrl, path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  return { status: response.status, body: await response.json() };
}

/**
 * Creates a guest account and returns its token.
 *
 * @param {string} baseUrl - The server's base URL.
 * @returns {Promise<string>} A bearer token.
 */
export async function createGuestToken(baseUrl) {
  const { body } = await request(baseUrl, '/api/v1/auth/guest', { method: 'POST' });
  return body.data.token;
}

/**
 * Creates a session ready for the tutoring tests.
 *
 * Defaults to the quadratic used throughout the docs, because the mock provider
 * returns the documented three-step plan for it.
 *
 * @param {string} baseUrl - The server's base URL.
 * @param {string} token - A bearer token.
 * @param {object} [overrides] - Fields to override in the request body.
 * @returns {Promise<{session: object, steps: object[]}>}
 */
export async function createTestSession(baseUrl, token, overrides = {}) {
  const { body } = await request(baseUrl, '/api/v1/sessions', {
    method: 'POST',
    token,
    body: {
      subjectId: 'mathematics',
      problem: 'solve 2x^2 - 5x - 3 = 0',
      ...overrides,
    },
  });

  return { session: body.data.session, steps: body.data.steps, raw: body.data };
}
