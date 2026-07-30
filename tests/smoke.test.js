/**
 * @file The happy path, end to end, plus every error response.
 *
 * If this file passes, the API is wired up correctly: routing, auth, validation,
 * serialisation, and the error envelope all work. Run it before every commit.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, request, createGuestToken, createTestSession } from './helpers.js';

let server;
let token;

before(async () => {
  server = await startTestServer();
  token = await createGuestToken(server.baseUrl);
});

after(async () => {
  await server.close();
});

describe('health and reference data', () => {
  test('GET /health reports the process is alive', async () => {
    const { status, body } = await request(server.baseUrl, '/health');
    assert.equal(status, 200);
    assert.equal(body.data.status, 'ok');
  });

  test('GET /health/ready reports configuration is valid', async () => {
    const { status, body } = await request(server.baseUrl, '/health/ready');
    assert.equal(status, 200);
    assert.equal(body.data.status, 'ready');
    assert.equal(body.data.checks.config, 'ok');
  });

  test('GET /subjects returns the eight landing-page subjects', async () => {
    const { status, body } = await request(server.baseUrl, '/api/v1/subjects');
    assert.equal(status, 200);
    assert.equal(body.data.subjects.length, 8);

    const ids = body.data.subjects.map((subject) => subject.id);
    assert.deepEqual(ids, [
      'mathematics', 'physics', 'chemistry', 'programming',
      'biology', 'economics', 'languages', 'standardized-tests',
    ]);
  });

  test('every response carries a request id', async () => {
    const { body } = await request(server.baseUrl, '/api/v1/subjects');
    assert.match(body.requestId, /^req_/);
  });
});

describe('guest authentication', () => {
  test('POST /auth/guest issues a token with no signup', async () => {
    const { status, body } = await request(server.baseUrl, '/api/v1/auth/guest', { method: 'POST' });
    assert.equal(status, 201);
    assert.match(body.data.user.id, /^usr_/);
    assert.equal(body.data.user.isGuest, true);
    assert.ok(body.data.token);
    assert.ok(Date.parse(body.data.expiresAt) > Date.now());
  });

  test('GET /auth/me identifies the token holder', async () => {
    const { status, body } = await request(server.baseUrl, '/api/v1/auth/me', { token });
    assert.equal(status, 200);
    assert.match(body.data.user.id, /^usr_/);
  });

  test('POST /auth/refresh returns a working token', async () => {
    const { body } = await request(server.baseUrl, '/api/v1/auth/refresh', { method: 'POST', token });
    const { status } = await request(server.baseUrl, '/api/v1/auth/me', { token: body.data.token });
    assert.equal(status, 200);
  });
});

describe('the full session lifecycle', () => {
  test('creating a session returns the numbered step plan', async () => {
    const { session, steps } = await createTestSession(server.baseUrl, token);

    assert.match(session.id, /^ses_/);
    assert.equal(session.subjectId, 'mathematics');
    assert.equal(session.title, 'Quadratic equations');
    assert.equal(session.status, 'active');
    assert.equal(session.currentStepIndex, 1);

    assert.equal(steps.length, 3);
    assert.deepEqual(steps.map((step) => step.index), [1, 2, 3]);
    // The first step is active and the rest wait — this drives the progress bar.
    assert.equal(steps[0].status, 'active');
    assert.equal(steps[1].status, 'pending');
  });

  test('the final answer is NEVER sent to the client', async () => {
    // The single most important assertion in this file. If `finalAnswer` ever
    // reaches the browser, a student can read it from the network tab without
    // doing a step, and the product quietly stops working as intended.
    const { session } = await createTestSession(server.baseUrl, token);
    assert.equal(session.finalAnswer, undefined);

    const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}`, { token });
    assert.equal(body.data.session.finalAnswer, undefined);

    // Belt and braces: no serialised response anywhere may contain the answer.
    assert.ok(!JSON.stringify(body).includes('x = −1/2 or x = 3'));
  });

  test('sessions are listed newest first', async () => {
    const freshToken = await createGuestToken(server.baseUrl);
    await createTestSession(server.baseUrl, freshToken, { problem: 'solve x^2 = 9' });
    await createTestSession(server.baseUrl, freshToken, { problem: 'solve 2x^2 - 5x - 3 = 0' });

    const { body } = await request(server.baseUrl, '/api/v1/sessions', { token: freshToken });
    assert.equal(body.data.total, 2);
    assert.ok(body.data.sessions[0].createdAt >= body.data.sessions[1].createdAt);
  });

  test('a session can be renamed and deleted', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    const renamed = await request(server.baseUrl, `/api/v1/sessions/${session.id}`, {
      method: 'PATCH', token, body: { title: 'My quadratic' },
    });
    assert.equal(renamed.body.data.session.title, 'My quadratic');

    const deleted = await request(server.baseUrl, `/api/v1/sessions/${session.id}`, {
      method: 'DELETE', token,
    });
    assert.equal(deleted.body.data.deleted, true);

    const gone = await request(server.baseUrl, `/api/v1/sessions/${session.id}`, { token });
    assert.equal(gone.status, 404);
  });

  test('one student cannot read another student\'s session', async () => {
    const { session } = await createTestSession(server.baseUrl, token);
    const otherToken = await createGuestToken(server.baseUrl);

    const { status, body } = await request(
      server.baseUrl, `/api/v1/sessions/${session.id}`, { token: otherToken },
    );
    // 404 rather than 403 on purpose: "exists but is not yours" would confirm
    // the id is real, which is information the caller has no business having.
    assert.equal(status, 404);
    assert.equal(body.error.code, 'SESSION_NOT_FOUND');
  });
});

describe('error responses', () => {
  test('a missing token gives 401 UNAUTHENTICATED', async () => {
    const { status, body } = await request(server.baseUrl, '/api/v1/sessions');
    assert.equal(status, 401);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  test('a rubbish token gives 401 UNAUTHENTICATED', async () => {
    const { status, body } = await request(server.baseUrl, '/api/v1/sessions', {
      token: 'not-a-real-token',
    });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  test('an invalid subject gives 422 with the offending field named', async () => {
    const { status, body } = await request(server.baseUrl, '/api/v1/sessions', {
      method: 'POST', token, body: { subjectId: 'astrology', problem: 'what is my star sign' },
    });
    assert.equal(status, 422);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(body.error.details.fields.some((field) => field.path === 'subjectId'));
  });

  test('a too-short problem gives 422', async () => {
    const { status, body } = await request(server.baseUrl, '/api/v1/sessions', {
      method: 'POST', token, body: { subjectId: 'mathematics', problem: 'x' },
    });
    assert.equal(status, 422);
    assert.ok(body.error.details.fields.some((field) => field.path === 'problem'));
  });

  test('an unknown session gives 404 SESSION_NOT_FOUND', async () => {
    const { status, body } = await request(server.baseUrl, '/api/v1/sessions/ses_doesnotexist', { token });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'SESSION_NOT_FOUND');
  });

  test('an unknown route gives 404 NOT_FOUND in the JSON envelope', async () => {
    const { status, body } = await request(server.baseUrl, '/api/v1/nope');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});
