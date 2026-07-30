/**
 * @file The tutoring behaviour: modes, marking, the reveal gate, and streaming.
 *
 * These tests cover the product's actual promises. The mock provider returns
 * fixed replies, so what is being tested here is *our* logic — the state
 * machine, the mode routing, the step bookkeeping — not the model's wording.
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

describe('marking — "get marked, not just graded"', () => {
  test('names the exact step that broke, not just "wrong"', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    const { status, body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/check`, {
      method: 'POST', token,
      // The documented sign error: both signs flipped.
      body: { attempt: 'x = 1/2 or x = -3' },
    });

    assert.equal(status, 200);
    const { marking } = body.data;

    assert.equal(marking.overall, 'incorrect');
    // This is the whole feature: which step, not merely that something failed.
    assert.equal(marking.firstBrokenStepIndex, 3);
    assert.equal(marking.errorType, 'sign_error');
    assert.ok(marking.errorSummary);
    assert.ok(marking.nudge.length > 0);

    // Steps 1 and 2 were right, and the student is told so before the correction.
    assert.equal(marking.steps[0].verdict, 'correct');
    assert.equal(marking.steps[1].verdict, 'correct');
    assert.equal(marking.steps[2].verdict, 'incorrect');
  });

  test('the nudge never contains the final answer', async () => {
    const { session } = await createTestSession(server.baseUrl, token);
    const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/check`, {
      method: 'POST', token, body: { attempt: 'x = 1/2 or x = -3' },
    });
    assert.ok(!body.data.marking.nudge.includes('−1/2'));
    assert.ok(!body.data.marking.nudge.includes('-1/2'));
  });

  test('step statuses update so the UI can repaint the progress bar', async () => {
    const { session } = await createTestSession(server.baseUrl, token);
    const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/check`, {
      method: 'POST', token, body: { attempt: 'x = 1/2 or x = -3' },
    });

    const statuses = body.data.steps.map((step) => step.status);
    assert.deepEqual(statuses, ['correct', 'correct', 'incorrect']);
    // The student is moved back to the step that needs work.
    assert.equal(body.data.session.currentStepIndex, 3);
  });

  test('a marked mistake reaches the weakness report', async () => {
    const freshToken = await createGuestToken(server.baseUrl);
    const { session } = await createTestSession(server.baseUrl, freshToken);

    await request(server.baseUrl, `/api/v1/sessions/${session.id}/check`, {
      method: 'POST', token: freshToken, body: { attempt: 'x = 1/2 or x = -3' },
    });

    const { body } = await request(server.baseUrl, '/api/v1/insights/weaknesses', { token: freshToken });
    assert.equal(body.data.totalMistakes, 1);
    assert.equal(body.data.patterns[0].errorType, 'sign_error');
    // The summary is written ready to render, not assembled by the frontend.
    assert.match(body.data.patterns[0].summary, /Sign errors came up once/);
  });
});

describe('the reveal gate', () => {
  test('first ask gives a hint, second gives the answer', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    const first = await request(server.baseUrl, `/api/v1/sessions/${session.id}/reveal`, {
      method: 'POST', token,
    });
    assert.equal(first.body.data.revealed, false);
    assert.equal(first.body.data.revealAvailable, true);
    assert.equal(first.body.data.requirement, 'ask_again');

    const second = await request(server.baseUrl, `/api/v1/sessions/${session.id}/reveal`, {
      method: 'POST', token,
    });
    assert.equal(second.body.data.revealed, true);
    assert.equal(second.body.data.revealAvailable, false);
    assert.equal(second.body.data.session.answerRevealed, true);
  });

  test('answerPolicy "never" keeps the gate shut however often you ask', async () => {
    const { session } = await createTestSession(server.baseUrl, token, { answerPolicy: 'never' });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/reveal`, {
        method: 'POST', token,
      });
      assert.equal(body.data.revealed, false);
      // False so the frontend hides the button rather than offering something
      // that can never happen.
      assert.equal(body.data.revealAvailable, false);
      assert.equal(body.data.requirement, 'policy_never');
    }
  });

  test('answerPolicy "after_attempt" unlocks only once work is submitted', async () => {
    const { session } = await createTestSession(server.baseUrl, token, {
      answerPolicy: 'after_attempt',
    });

    const before = await request(server.baseUrl, `/api/v1/sessions/${session.id}/reveal`, {
      method: 'POST', token,
    });
    assert.equal(before.body.data.revealed, false);
    assert.equal(before.body.data.requirement, 'attempt_first');

    await request(server.baseUrl, `/api/v1/sessions/${session.id}/check`, {
      method: 'POST', token, body: { attempt: 'x = 1/2 or x = -3' },
    });

    const afterAttempt = await request(server.baseUrl, `/api/v1/sessions/${session.id}/reveal`, {
      method: 'POST', token,
    });
    assert.equal(afterAttempt.body.data.revealed, true);
  });

  test('asking for a hint does not consume the reveal gate', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    await request(server.baseUrl, `/api/v1/sessions/${session.id}/hint`, {
      method: 'POST', token, body: {},
    });

    // A hint is not an answer, so the first reveal must still behave like a first.
    const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/reveal`, {
      method: 'POST', token,
    });
    assert.equal(body.data.revealed, false);
    assert.equal(body.data.requirement, 'ask_again');
  });
});

describe('modes', () => {
  test('a mode passed by the frontend is respected', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/ask`, {
      method: 'POST', token,
      body: { message: 'what next?', mode: 'discuss' },
    });
    assert.equal(body.data.mode, 'discuss');
  });

  test('the mode is inferred when the frontend does not force one', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/ask`, {
      method: 'POST', token,
      body: { message: 'why does the sign flip here?' },
    });
    // "why …" is a request for reasoning, not a step to work through.
    assert.equal(body.data.mode, 'explain');
    assert.equal(body.data.refused, false);
  });

  test('explain answers a question about one step without unlocking the answer', async () => {
    const { session, steps } = await createTestSession(server.baseUrl, token);

    const { status, body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/explain`, {
      method: 'POST', token,
      body: { stepId: steps[2].id, question: 'why does the sign flip here?' },
    });

    assert.equal(status, 200);
    assert.equal(body.data.step.index, 3);
    assert.ok(body.data.message.content.length > 0);

    const check = await request(server.baseUrl, `/api/v1/sessions/${session.id}`, { token });
    assert.equal(check.body.data.session.answerRevealed, false);
  });

  test('an unknown stepId gives 404 STEP_NOT_FOUND', async () => {
    const { session } = await createTestSession(server.baseUrl, token);
    const { status, body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/explain`, {
      method: 'POST', token, body: { stepId: 'stp_nope' },
    });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'STEP_NOT_FOUND');
  });
});

describe('the transcript', () => {
  test('both sides of the conversation are recorded in order', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    await request(server.baseUrl, `/api/v1/sessions/${session.id}/ask`, {
      method: 'POST', token, body: { message: 'why does the sign flip here?' },
    });

    const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}`, { token });
    const { messages } = body.data;

    // The original problem seeds the transcript, then the question and reply.
    assert.ok(messages.length >= 3);
    assert.equal(messages.at(-2).role, 'user');
    assert.equal(messages.at(-1).role, 'assistant');
    assert.equal(messages.at(-1).mode, 'explain');
  });
});

describe('SSE streaming', () => {
  test('streams a reply as deltas and ends with done', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    const url = `${server.baseUrl}/api/v1/sessions/${session.id}/ask/stream`
      + `?message=${encodeURIComponent('why does the sign flip here?')}&token=${token}`;

    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const raw = await response.text();

    // Exactly one start event — the frontend relies on that.
    assert.equal(raw.match(/^event: start$/gm).length, 1);
    assert.ok(raw.includes('event: delta'));
    assert.ok(raw.includes('event: done'));

    // Reassembling the deltas must reproduce the whole reply.
    const deltas = [...raw.matchAll(/^event: delta\ndata: (.+)$/gm)]
      .map((match) => JSON.parse(match[1]).text)
      .join('');
    assert.ok(deltas.length > 0);
    assert.match(deltas, /divided by a negative/);
  });

  test('the stored transcript matches what was streamed', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    const url = `${server.baseUrl}/api/v1/sessions/${session.id}/ask/stream`
      + `?message=${encodeURIComponent('why does the sign flip here?')}&token=${token}`;
    const raw = await (await fetch(url)).text();

    const streamed = [...raw.matchAll(/^event: delta\ndata: (.+)$/gm)]
      .map((match) => JSON.parse(match[1]).text)
      .join('');

    const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}`, { token });
    assert.equal(body.data.messages.at(-1).content, streamed);
  });
});

describe('practice sets', () => {
  test('answers are hidden until the set is submitted', async () => {
    const { session } = await createTestSession(server.baseUrl, token);

    const generated = await request(server.baseUrl, `/api/v1/sessions/${session.id}/practice`, {
      method: 'POST', token, body: { count: 3 },
    });
    assert.equal(generated.status, 201);

    const set = generated.body.data.practiceSet;
    assert.equal(set.problems.length, 3);
    // Sending the answers alongside the questions would make the set pointless.
    assert.ok(set.problems.every((problem) => problem.answer === undefined));

    const submitted = await request(server.baseUrl, `/api/v1/practice/${set.id}/submit`, {
      method: 'POST', token,
      body: { answers: [
        { index: 1, answer: 'x=2 or x=3' },
        { index: 2, answer: 'no idea' },
        { index: 3, answer: 'no idea' },
      ] },
    });

    assert.equal(submitted.status, 200);
    assert.ok(submitted.body.data.practiceSet.results);
    // Now that they have committed, showing the answers is the point.
    assert.ok(submitted.body.data.practiceSet.problems.every((problem) => problem.answer));
  });

  test('another student cannot submit your practice set', async () => {
    const { session } = await createTestSession(server.baseUrl, token);
    const { body } = await request(server.baseUrl, `/api/v1/sessions/${session.id}/practice`, {
      method: 'POST', token, body: { count: 1 },
    });

    const otherToken = await createGuestToken(server.baseUrl);
    const { status, body: error } = await request(
      server.baseUrl, `/api/v1/practice/${body.data.practiceSet.id}/submit`,
      { method: 'POST', token: otherToken, body: { answers: [{ index: 1, answer: 'x' }] } },
    );

    assert.equal(status, 404);
    assert.equal(error.error.code, 'PRACTICE_SET_NOT_FOUND');
  });
});
