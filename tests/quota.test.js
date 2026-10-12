/**
 * @file The guest message quota — capped at `GUEST_MESSAGE_LIMIT`, then a 429
 * telling the student to sign in.
 *
 * Set before importing `helpers.js` (which only fills in a default — see its
 * `??=`), so this file runs against a deliberately tiny limit instead of the
 * real one. That keeps the test fast and the assertions exact, without
 * touching any other test file's shared guest token.
 */

process.env.GUEST_MESSAGE_LIMIT = '2';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

const { startTestServer, request, createGuestToken, createTestSession } = await import('./helpers.js');

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

describe('the guest message quota', () => {
  test('the limit counts session creation as the first message', async () => {
    const token = await createGuestToken(server.baseUrl);

    // Message 1 of 2: creating the session.
    const { session } = await createTestSession(server.baseUrl, token);
    assert.ok(session.id);

    // Message 2 of 2: still inside the limit.
    const stillOk = await request(server.baseUrl, `/api/v1/sessions/${session.id}/ask`, {
      method: 'POST', token, body: { message: 'why does the sign flip here?' },
    });
    assert.equal(stillOk.status, 200);

    // Over the limit: rejected before the AI is ever called.
    const blocked = await request(server.baseUrl, `/api/v1/sessions/${session.id}/ask`, {
      method: 'POST', token, body: { message: 'one more?' },
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'GUEST_LIMIT_REACHED');
  });

  test('a fresh guest token gets its own fresh quota', async () => {
    // The guest token in the test above already used up its limit of 2.
    // A brand new guest must not inherit that exhausted count.
    const newToken = await createGuestToken(server.baseUrl);
    const { session } = await createTestSession(server.baseUrl, newToken);
    assert.ok(session.id);
  });
});
