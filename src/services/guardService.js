/**
 * @file Decides whether Marg should help with a message, and what to say when
 * the answer is no.
 *
 * THE TWO GATES
 *
 * Gate 1 — topic. Is this study-related at all? A request to plan a holiday or
 * write a birthday song gets a warm redirect.
 *
 * Gate 2 — academic integrity. Even for a real school subject, is the student
 * asking to *learn* it or to have it *done*? This is the gate that matters,
 * and it is the one that is easy to get wrong.
 *
 * WHY THE OBVIOUS RULE WOULD BE WRONG
 * "Marg should not write code" cannot be the rule — Programming is one of the
 * eight subjects on the landing page. Debugging a loop, explaining recursion,
 * reviewing an attempt: all of that is the product working as intended. What
 * Marg declines is taking an assignment specification and returning the
 * finished program. Same for essays: it plans and critiques, it does not
 * ghostwrite.
 *
 * So the axis is **learning vs. outsourcing**, never the topic. A keyword ban
 * on "code" or "song" would block legitimate work and make the app feel broken.
 *
 * REFUSALS ARE NOT ERRORS
 * A redirect comes back as HTTP 200 with a normal assistant message and
 * `meta.refused = true`. The frontend renders it as an ordinary chat bubble.
 * Sending a 4xx would make a perfectly reasonable conversational moment look
 * like a bug.
 */

import { env } from '../config/env.js';

/**
 * What Marg says when a request is off topic. Warm, short, and immediately
 * useful — it tells the student what *would* work.
 *
 * @private
 * @type {string}
 */
const OFF_TOPIC_REPLY = `That one is outside what I do — I'm built for working through study problems.

Bring me something you're stuck on — a maths question, a physics problem, code that won't behave, a chemistry mechanism — and I'll walk through it with you.`;

/**
 * What Marg says when a student wants the work done rather than taught.
 *
 * The wording here took some care. It does not scold, it does not mention
 * cheating, and it does not end on a refusal — it declines and offers the real
 * help in the same breath, so the student's next move is obvious.
 *
 * @private
 * @param {string|null} subjectId - The subject, used to tailor the offer.
 * @returns {string} The reply text.
 */
function buildIntegrityReply(subjectId) {
  const offers = {
    programming: `I'd rather get you there than hand it over. Tell me what the program needs to do and where you're stuck, and we'll build it a piece at a time — I'll check each bit as you go.`,
    languages: `I'd rather help you write it than write it for you. Give me your thesis or your first paragraph and I'll tell you what's working and what isn't.`,
    economics: `I'd rather help you build the argument than hand you one. What's your main claim? Start there and I'll push back on it like a marker would.`,
  };

  const offer = offers[subjectId]
    ?? `I'd rather get you there than hand it over. Tell me where you're stuck and we'll work through it together.`;

  return `I'm not going to produce that one for you — it's the bit you're being marked on.

${offer}`;
}

/**
 * A guard decision.
 *
 * @typedef {object} GuardDecision
 * @property {boolean} allowed - Whether the teaching call should proceed.
 * @property {string} [reply] - The message to send instead, when not allowed.
 * @property {'off_topic'|'integrity'} [refusalReason] - Which gate stopped it.
 * @property {boolean} [coachInstead] - True when Marg declined the artifact but
 *   should still tutor the underlying material.
 */

/**
 * Applies both gates to a triage result.
 *
 * @param {object} triage - A result from `triageService.triageMessage`.
 * @returns {GuardDecision} What to do with this turn.
 *
 * @example
 * evaluate({ category: 'off_topic', … });
 * // { allowed: false, refusalReason: 'off_topic', reply: '…' }
 *
 * evaluate({ category: 'academic', integrityRisk: 'high', subjectId: 'programming' });
 * // { allowed: false, refusalReason: 'integrity', coachInstead: true, reply: '…' }
 */
export function evaluate(triage) {
  // The boundary can be switched off entirely for a demo or an internal build.
  if (!env.STRICT_SCOPE) return { allowed: true };

  // Questions about Marg itself always get answered. Refusing "what can you
  // do?" is the classic guardrail bug and it makes a product feel hostile on
  // the very first message, so it is checked before anything else.
  if (triage.category === 'meta') return { allowed: true };

  if (triage.category === 'off_topic' || triage.inScope === false) {
    return {
      allowed: false,
      refusalReason: 'off_topic',
      reply: OFF_TOPIC_REPLY,
    };
  }

  // In scope, but they want the graded artifact produced for them. Marg
  // declines the artifact and pivots to teaching the same material — which is
  // why `coachInstead` is set: the session stays open and useful.
  if (triage.integrityRisk === 'high') {
    return {
      allowed: false,
      refusalReason: 'integrity',
      coachInstead: true,
      reply: buildIntegrityReply(triage.subjectId),
    };
  }

  // `low` risk still goes through. The student wants a lot handed over but is
  // engaged with the material, and the system prompt already leans against
  // doing too much. Blocking here would produce false refusals on ordinary
  // "can you just show me how this works" messages.
  return { allowed: true };
}
