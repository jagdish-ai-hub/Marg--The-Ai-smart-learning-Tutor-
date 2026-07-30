/**
 * @file The teaching brain. Every conversational turn goes through here.
 *
 * THE SHAPE OF A TURN
 *   1. triage    — one cheap call: is this in scope, and what is being asked?
 *   2. guard     — should we proceed, or redirect?
 *   3. mode      — guide, explain, discuss, or check?
 *   4. gate      — if they want the answer, have they unlocked it?
 *   5. generate  — the actual teaching call, streamed or not
 *   6. record    — append to the transcript, update step state
 *
 * THE REVEAL GATE, AND WHY IT IS CODE
 * "Do not give away the answer" written in a prompt is a suggestion. A student
 * who asks firmly enough, or pastes "ignore your previous instructions", will
 * often get it. So the gate is a state machine here, and the answer is simply
 * absent from the prompt until the state machine opens — a model cannot leak
 * what it was never told. The prompt rule and the code check back each other up.
 */

import { store } from '../store/index.js';
import { generateText, streamText } from '../ai/registry.js';
import { buildTutorSystemPrompt } from '../prompts/tutorSystem.js';
import { buildHintPrompt, buildRevealPrompt } from '../prompts/tasks.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { chunkText } from '../utils/sse.js';
import { logger } from '../utils/logger.js';
import { triageMessage } from './triageService.js';
import * as guardService from './guardService.js';
import { resolveMode } from './intentService.js';
import { buildConversationHistory } from './sessionService.js';

/**
 * Decides whether the student has earned the full answer.
 *
 * Three policies, set per session:
 *
 *   never          — hints only, forever
 *   on_request     — the default. Asking once gets a hint plus a plain offer;
 *                    asking again opens the gate. The friction is the point:
 *                    it gives them one more moment to try, without ever making
 *                    giving up impossible. Wanting the answer is allowed.
 *   after_attempt  — they must submit an attempt at the step first. Strongest
 *                    for learning, best suited to teacher-configured sessions.
 *
 * @param {object} session - The session record.
 * @returns {{unlocked: boolean, requirement: string|null}}
 *   `unlocked` says whether to hand over the answer. `requirement` names what
 *   is still missing, so the caller can explain it to the student.
 *
 * @example
 * evaluateRevealGate({ answerPolicy: 'on_request', revealCount: 0 });
 * // { unlocked: false, requirement: 'ask_again' }
 * evaluateRevealGate({ answerPolicy: 'on_request', revealCount: 1 });
 * // { unlocked: true, requirement: null }
 */
export function evaluateRevealGate(session) {
  if (session.answerRevealed) return { unlocked: true, requirement: null };

  switch (session.answerPolicy) {
    case 'never':
      return { unlocked: false, requirement: 'policy_never' };

    case 'after_attempt':
      return (session.attemptCount ?? 0) > 0
        ? { unlocked: true, requirement: null }
        : { unlocked: false, requirement: 'attempt_first' };

    case 'on_request':
    default:
      // revealCount counts how many times they have asked. The first ask is
      // recorded and answered with a hint; the second opens the gate.
      return (session.revealCount ?? 0) >= 1
        ? { unlocked: true, requirement: null }
        : { unlocked: false, requirement: 'ask_again' };
  }
}

/**
 * The extra instruction Marg gets when the student wants the answer but the
 * gate is still shut. Explains the situation honestly rather than pretending
 * the answer does not exist.
 *
 * @private
 * @param {string} requirement - From {@link evaluateRevealGate}.
 * @returns {string} Extra system prompt text.
 */
function buildGateInstruction(requirement) {
  switch (requirement) {
    case 'policy_never':
      return `${buildHintPrompt()}\n\nThis session is set to hints only. If they ask for the answer, say so plainly and without apology, then give them the best hint you have.`;
    case 'attempt_first':
      return `${buildHintPrompt()}\n\nThe student is asking for the answer but has not attempted the current step. Tell them briefly that you will show it once they have had a go, then give them a hint that makes attempting it feel possible.`;
    case 'ask_again':
    default:
      return `${buildHintPrompt()}\n\nThe student is asking for the answer. Give them a real hint first, then tell them plainly — one short sentence, no guilt — that you can show the full worked answer if they would rather. They are allowed to want it.`;
  }
}

/**
 * Assembles the system prompt and message list for a teaching call.
 *
 * @private
 * @param {object} options
 * @param {object} options.session - The session.
 * @param {object[]} options.steps - Its steps.
 * @param {string} options.mode - The resolved mode.
 * @param {string} options.message - What the student just wrote.
 * @param {boolean} options.answerUnlocked - Whether to include the answer.
 * @param {string} [options.extra] - Extra system instructions.
 * @returns {Promise<{system: string, messages: object[]}>}
 */
async function buildTurn({ session, steps, mode, message, answerUnlocked, extra }) {
  const system = buildTutorSystemPrompt({
    session,
    steps,
    mode,
    answerPolicy: session.answerPolicy,
    answerUnlocked,
    extra,
  });

  const history = await buildConversationHistory(session.id, 8);
  return { system, messages: [...history, { role: 'user', content: message }] };
}

/**
 * Runs triage and the guardrails, and works out the mode and reveal state.
 *
 * Shared by the streaming and non-streaming paths so the two can never drift
 * apart — a rule enforced on one but not the other would be a real hole.
 *
 * @private
 * @param {object} options
 * @param {object} options.session - The session.
 * @param {string} options.message - The student's message.
 * @param {string} [options.requestedMode] - Mode forced by the frontend.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<object>} Everything the generate step needs.
 */
async function prepareTurn({ session, message, requestedMode, signal }) {
  const triage = await triageMessage({ message, session, signal });
  const decision = guardService.evaluate(triage);

  if (!decision.allowed) {
    return { blocked: true, decision, triage };
  }

  const { mode, source } = resolveMode({ requestedMode, triage });

  let answerUnlocked = false;
  let extra = '';

  // Only consult the gate when the student is actually asking for the answer.
  // An ordinary "what do I do next?" should never touch reveal state.
  if (triage.wantsAnswer) {
    const gate = evaluateRevealGate(session);
    answerUnlocked = gate.unlocked;

    if (gate.unlocked) {
      extra = buildRevealPrompt();
      await store.sessions.update(session.id, { answerRevealed: true });
    } else {
      extra = buildGateInstruction(gate.requirement);
      // Record the ask, so the next one opens the gate.
      await store.sessions.update(session.id, {
        revealCount: (session.revealCount ?? 0) + 1,
      });
    }
  }

  return { blocked: false, triage, mode, modeSource: source, answerUnlocked, extra };
}

/**
 * Answers a student's message and returns the complete reply.
 *
 * @param {object} options
 * @param {object} options.session - The session.
 * @param {object[]} options.steps - Its steps.
 * @param {string} options.message - What the student wrote.
 * @param {string} [options.requestedMode] - Force a mode, e.g. from a UI button.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<{message: object, mode: string, refused: boolean, revealAvailable: boolean}>}
 *   The stored assistant message and what happened.
 *
 * @example
 * const result = await ask({ session, steps, message: 'why does the sign flip here?' });
 * result.mode;              // 'explain'
 * result.message.content;   // 'Because you divided by a negative — …'
 */
export async function ask({ session, steps, message, requestedMode, signal }) {
  await store.messages.append({
    sessionId: session.id,
    role: 'user',
    content: message,
  });

  const prepared = await prepareTurn({ session, message, requestedMode, signal });

  // The guardrails declined. Store the redirect as a normal assistant message
  // so it appears in the transcript exactly like any other reply, and return
  // HTTP 200 — a redirect is a conversation, not a failure.
  if (prepared.blocked) {
    const stored = await store.messages.append({
      sessionId: session.id,
      role: 'assistant',
      content: prepared.decision.reply,
      mode: 'discuss',
      meta: { refused: true, refusalReason: prepared.decision.refusalReason },
    });
    return { message: stored, mode: 'discuss', refused: true, revealAvailable: false };
  }

  const { system, messages } = await buildTurn({
    session,
    steps,
    mode: prepared.mode,
    message,
    answerUnlocked: prepared.answerUnlocked,
    extra: prepared.extra,
  });

  const reply = await generateText({
    system,
    messages,
    temperature: 0.5,
    maxTokens: 900,
    signal,
  });

  const stored = await store.messages.append({
    sessionId: session.id,
    role: 'assistant',
    content: reply.text,
    mode: prepared.mode,
    meta: { refused: false },
  });

  await store.sessions.update(session.id, { mode: prepared.mode });

  logger.info('Tutor turn complete', {
    sessionId: session.id,
    mode: prepared.mode,
    modeSource: prepared.modeSource,
    answerUnlocked: prepared.answerUnlocked,
  });

  return {
    message: stored,
    mode: prepared.mode,
    refused: false,
    // Tells the frontend it can offer a "show me the answer" button, because
    // asking once more would now open the gate.
    revealAvailable: prepared.triage.wantsAnswer && !prepared.answerUnlocked,
  };
}

/**
 * Answers a student's message, yielding the reply in pieces for SSE.
 *
 * Same rules and the same state machine as {@link ask} — the only difference is
 * how the text reaches the client.
 *
 * @param {object} options
 * @param {object} options.session - The session.
 * @param {object[]} options.steps - Its steps.
 * @param {string} options.message - What the student wrote.
 * @param {string} [options.requestedMode] - Force a mode.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @yields {object} `{type: 'meta'|'delta'|'done', …}` events.
 * @returns {AsyncGenerator<object>}
 */
export async function* askStream({ session, steps, message, requestedMode, signal }) {
  await store.messages.append({
    sessionId: session.id,
    role: 'user',
    content: message,
  });

  const prepared = await prepareTurn({ session, message, requestedMode, signal });

  if (prepared.blocked) {
    const stored = await store.messages.append({
      sessionId: session.id,
      role: 'assistant',
      content: prepared.decision.reply,
      mode: 'discuss',
      meta: { refused: true, refusalReason: prepared.decision.refusalReason },
    });

    // Stream the redirect the same way as any other reply, so the frontend
    // needs no special case to render it.
    yield { type: 'meta', messageId: stored.id, mode: 'discuss', refused: true };
    for (const chunk of chunkText(prepared.decision.reply, 5)) {
      yield { type: 'delta', text: chunk };
    }
    yield {
      type: 'done',
      messageId: stored.id,
      refused: true,
      refusalReason: prepared.decision.refusalReason,
    };
    return;
  }

  const { system, messages } = await buildTurn({
    session,
    steps,
    mode: prepared.mode,
    message,
    answerUnlocked: prepared.answerUnlocked,
    extra: prepared.extra,
  });

  yield { type: 'meta', mode: prepared.mode, refused: false };

  let full = '';
  let usage = { inputTokens: 0, outputTokens: 0 };

  for await (const chunk of streamText({ system, messages, temperature: 0.5, maxTokens: 900, signal })) {
    if (chunk.type === 'delta') {
      full += chunk.text;
      yield { type: 'delta', text: chunk.text };
    } else if (chunk.type === 'done') {
      usage = chunk.usage ?? usage;
    }
  }

  // Only store once the reply is complete. A half-written message in the
  // transcript would poison the context of every later turn.
  const stored = await store.messages.append({
    sessionId: session.id,
    role: 'assistant',
    content: full,
    mode: prepared.mode,
    meta: { refused: false },
  });

  await store.sessions.update(session.id, { mode: prepared.mode });

  yield {
    type: 'done',
    messageId: stored.id,
    mode: prepared.mode,
    usage,
    refused: false,
    revealAvailable: prepared.triage.wantsAnswer && !prepared.answerUnlocked,
  };
}

/**
 * Produces the smallest useful hint for the step the student is on.
 *
 * Deliberately does not touch the reveal gate: a hint is not an answer, and
 * asking for one should never count against the student.
 *
 * @param {object} options
 * @param {object} options.session - The session.
 * @param {object[]} options.steps - Its steps.
 * @param {number} [options.stepIndex] - Which step. Defaults to the current one.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<{message: object}>} The stored hint message.
 */
export async function hint({ session, steps, stepIndex, signal }) {
  const index = stepIndex ?? session.currentStepIndex ?? 1;
  const step = steps.find((item) => item.index === index) ?? steps[0];

  const system = buildTutorSystemPrompt({
    session,
    steps,
    mode: 'guide',
    answerPolicy: session.answerPolicy,
    answerUnlocked: false,
    extra: buildHintPrompt(),
  });

  const reply = await generateText({
    system,
    messages: [{
      role: 'user',
      content: `I'm stuck on step ${index}: ${step?.instruction ?? 'this problem'}. Give me a hint.`,
    }],
    temperature: 0.6,
    maxTokens: 250,
    signal,
  });

  const stored = await store.messages.append({
    sessionId: session.id,
    role: 'assistant',
    content: reply.text,
    mode: 'guide',
    meta: { refused: false, kind: 'hint', stepIndex: index },
  });

  return { message: stored };
}

/**
 * Handles an explicit "show me the answer" request — the friction gate as an
 * endpoint, so the frontend can put it behind a button.
 *
 * First call returns a hint and reports that the answer is now available.
 * Second call hands over the full worked solution.
 *
 * @param {object} options
 * @param {object} options.session - The session.
 * @param {object[]} options.steps - Its steps.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<{message: object, revealed: boolean, revealAvailable: boolean, requirement: string|null}>}
 */
export async function reveal({ session, steps, signal }) {
  const gate = evaluateRevealGate(session);

  if (!gate.unlocked) {
    const reply = await generateText({
      system: buildTutorSystemPrompt({
        session,
        steps,
        mode: 'guide',
        answerPolicy: session.answerPolicy,
        answerUnlocked: false,
        extra: buildGateInstruction(gate.requirement),
      }),
      messages: [{ role: 'user', content: 'Can you just give me the answer?' }],
      temperature: 0.5,
      maxTokens: 300,
      signal,
    });

    await store.sessions.update(session.id, { revealCount: (session.revealCount ?? 0) + 1 });

    const stored = await store.messages.append({
      sessionId: session.id,
      role: 'assistant',
      content: reply.text,
      mode: 'guide',
      meta: { refused: false, kind: 'hint', gated: true },
    });

    return {
      message: stored,
      revealed: false,
      // False under `never`: no amount of asking will open that gate, and
      // showing a button that cannot work would be a lie.
      revealAvailable: gate.requirement !== 'policy_never',
      requirement: gate.requirement,
    };
  }

  const reply = await generateText({
    system: buildTutorSystemPrompt({
      session,
      steps,
      mode: 'explain',
      answerPolicy: session.answerPolicy,
      answerUnlocked: true,
      extra: buildRevealPrompt(),
    }),
    messages: [{ role: 'user', content: 'Show me the full worked answer.' }],
    temperature: 0.3,
    maxTokens: 900,
    signal,
  });

  await store.sessions.update(session.id, { answerRevealed: true, status: 'completed' });
  for (const step of steps) {
    await store.steps.setStatus(session.id, step.index, 'revealed');
  }

  const stored = await store.messages.append({
    sessionId: session.id,
    role: 'assistant',
    content: reply.text,
    mode: 'explain',
    meta: { refused: false, kind: 'reveal' },
  });

  logger.info('Answer revealed', { sessionId: session.id });

  return { message: stored, revealed: true, revealAvailable: false, requirement: null };
}

/**
 * Explains one specific step in more depth — the "wait, why does the sign flip
 * here?" moment from the landing page.
 *
 * @param {object} options
 * @param {object} options.session - The session.
 * @param {object[]} options.steps - Its steps.
 * @param {string} [options.stepId] - Which step. Defaults to the current one.
 * @param {string} [options.question] - The student's specific question.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<{message: object, step: object}>}
 * @throws {ApiError} `STEP_NOT_FOUND` if `stepId` is not in this session.
 */
export async function explainStep({ session, steps, stepId, question, signal }) {
  const step = stepId
    ? steps.find((item) => item.id === stepId)
    : steps.find((item) => item.index === (session.currentStepIndex ?? 1));

  if (!step) {
    throw ApiError.notFound(ErrorCodes.STEP_NOT_FOUND, 'No step with that id in this session.');
  }

  const ask = question?.trim()
    || `Explain step ${step.index} ("${step.instruction}") in more detail. Why does it work?`;

  const reply = await generateText({
    system: buildTutorSystemPrompt({
      session,
      steps,
      mode: 'explain',
      answerPolicy: session.answerPolicy,
      // Explaining *why a step works* never requires the final answer, so the
      // gate stays shut here regardless of how the question is phrased.
      answerUnlocked: false,
    }),
    messages: [{ role: 'user', content: ask }],
    temperature: 0.5,
    maxTokens: 700,
    signal,
  });

  const stored = await store.messages.append({
    sessionId: session.id,
    role: 'assistant',
    content: reply.text,
    mode: 'explain',
    meta: { refused: false, kind: 'explain', stepIndex: step.index },
  });

  return { message: stored, step };
}
