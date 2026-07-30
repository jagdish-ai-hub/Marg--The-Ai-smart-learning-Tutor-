/**
 * @file The prompts for Marg's specific jobs — triage, planning, marking,
 * hinting, practice, and reading a photo.
 *
 * Kept apart from `tutorSystem.js` on purpose. That file is Marg's character;
 * this one is the set of tasks it performs. You will edit this file often
 * (tuning a prompt is normal) and that one rarely.
 */

import { subjectListForPrompt } from './tutorSystem.js';

/**
 * Instructions for the fast triage call that runs before each turn.
 *
 * One small request answers both "should we help with this?" and "what kind of
 * help is wanted?". The examples matter enormously here — they are what stop
 * the classifier refusing legitimate programming and literature work, which is
 * the failure mode that would make Marg feel broken.
 *
 * @returns {string} The triage system prompt.
 */
export function buildTriagePrompt() {
  return `You classify a student's message for a tutoring app. Reply with JSON only.

The app tutors these subjects:
${subjectListForPrompt()}

Decide four things.

1. inScope + category
   - "academic": any genuine study question in any of the subjects above, plus
     study skills and exam technique.
   - "meta": about the app itself — "what can you do?", "how do I use this?",
     greetings. ALWAYS in scope.
   - "off_topic": not about learning at all.

2. subjectId — the best-matching id from the list, or null.

3. integrityRisk — is the student trying to learn, or to get the work done?
   - "none": a normal learning question.
   - "low":  wants a lot handed over, but is still engaged with the material.
   - "high": asking the app to PRODUCE the assessed artifact itself.

4. mode — what kind of help is wanted.
   - "guide":   wants to work through it. The default.
   - "explain": asking why something works, or for a worked example.
   - "discuss": a concept question with no specific problem attached.
   - "check":   submitting an attempt to be marked.

Also set wantsAnswer: true if they are explicitly asking for the final answer.

JUDGE THE PURPOSE, NOT THE TOPIC. These distinctions are the ones that matter:

"why does my for loop go out of bounds?"
  -> academic, programming, integrityRisk none, mode explain.
     Debugging is teaching. This is exactly what the app is for.

"here is my assignment spec, write the program"
  -> academic, programming, integrityRisk HIGH, mode guide.
     In scope, but they want the artifact produced for them.

"explain how recursion works"
  -> academic, programming, integrityRisk none, mode discuss.

"write my 1500 word essay on the French Revolution"
  -> academic, integrityRisk HIGH.

"help me structure my essay on the French Revolution"
  -> academic, integrityRisk none. Structuring is coaching, not ghostwriting.

"analyse the metaphors in these Spanish song lyrics"
  -> academic, languages, integrityRisk none.
     Literary analysis. The word "song" does NOT make it off topic.

"write me a song for my girlfriend's birthday"
  -> off_topic. Creative work with no learning purpose.

"what can you do?"
  -> meta, inScope true. Never refuse this.

"check this: x = 1/2 or x = -3"
  -> academic, mode check.`;
}

/**
 * Instructions for turning a raw problem into the numbered step card.
 *
 * @param {string} subjectId - The chosen subject.
 * @returns {string} The step-plan system prompt.
 */
export function buildStepPlanPrompt(subjectId) {
  return `You are planning how a student should work through a ${subjectId} problem.

Break it into the steps a good tutor would walk them through — usually 3 to 5.
Fewer than 3 is too vague to act on; more than 6 is overwhelming on a phone.

Each step:
- is one action the student performs, written as an instruction to them
  ("Factor the quadratic into two brackets"), not a narration of what happens
- is something they could plausibly attempt on their own with a nudge
- carries a short lowercase "skill" tag naming the underlying technique
  (e.g. "factoring", "unit-conversion", "free-body-diagram"). These tags are
  matched across sessions to spot recurring weaknesses, so use consistent,
  general names rather than one-off phrasings.

Also produce:
- title: 2-4 words for the session list, e.g. "Quadratic equations"
- topic: the specific skill, e.g. "Factoring quadratics"
- restatedProblem: the problem written cleanly, fixing obvious typos
- finalAnswer: the correct final answer, worked out properly

The finalAnswer is stored privately and is NOT shown to the student until they
unlock it, so give the real answer — do not hedge or leave it blank.

Reply with JSON only.`;
}

/**
 * Instructions for marking a student's attempt.
 *
 * This is the product's core promise — "get marked, not just graded" — so the
 * prompt is unusually specific about naming the step and the mistake.
 *
 * @param {object} session - The session being marked.
 * @param {object[]} steps - The session's steps.
 * @returns {string} The marking system prompt.
 */
export function buildMarkingPrompt(session, steps) {
  const stepList = steps
    .map((step) => `  ${step.index}. ${step.instruction}`)
    .join('\n');

  return `You are marking a student's attempt at a ${session.subjectId} problem.

The problem: ${session.restatedProblem}
The correct final answer: ${session.finalAnswer}

The steps they were asked to work through:
${stepList}

Your job is NOT to say right or wrong. It is to find the exact point where
their reasoning broke, so they can see it themselves.

Rules:
- Give a verdict for every step. Use "not_attempted" for steps their working
  does not reach.
- firstBrokenStepIndex is the FIRST step that went wrong. Everything after a
  broken step is usually downstream of that one mistake — do not mark the same
  error four times.
- If the attempt is entirely correct, set firstBrokenStepIndex and errorType
  and errorSummary to null, and make the nudge a genuine, specific compliment.
- errorType is a short snake_case tag, reused consistently across students:
  sign_error, arithmetic_slip, wrong_formula, unit_conversion, off_by_one,
  algebra_rearrangement, misread_question, incomplete_working, concept_confusion.
- The nudge is what they should try next. It must NOT contain the final answer.
  A good nudge is a question: "Take 2x + 1 = 0 on its own — what is x?"
- Comments on correct steps should be brief and specific. "Good" is worthless;
  "the factoring is right, and that's the hard part here" is worth reading.

Reply with JSON only.`;
}

/**
 * Instructions for producing a hint.
 *
 * @returns {string} Extra system instructions for a hint call.
 */
export function buildHintPrompt() {
  return `HINT REQUEST:
Give the SMALLEST hint that would genuinely unstick this student.

A good hint points at where to look, or asks the question they have not asked
themselves. It does not perform the step.

Bad:  "Divide both sides by 2 to get x = -1/2."   (that is the step, done)
Good: "Look at 2x + 1 = 0 on its own. What has to happen to the +1 first?"

Two sentences at most. No preamble — start with the hint itself.`;
}

/**
 * Instructions for the full reveal, once the student has unlocked it.
 *
 * @returns {string} Extra system instructions for a reveal call.
 */
export function buildRevealPrompt() {
  return `REVEAL:
The student has unlocked the full answer. Give it properly.

- Work through every step, showing the actual working, not a summary.
- Use the step numbers from the card so it lines up with what they see.
- End with the single idea most worth remembering — the thing that would stop
  this mistake happening again.
- Do not make them feel bad for asking. They asked twice; that is allowed.`;
}

/**
 * Instructions for generating practice problems.
 *
 * @param {string} subjectId - The subject.
 * @param {string} skill - The skill to drill.
 * @param {number} count - How many problems.
 * @returns {string} The practice system prompt.
 */
export function buildPracticePrompt(subjectId, skill, count) {
  return `Write ${count} fresh ${subjectId} problems that drill this skill: ${skill}.

Rules:
- They must be genuinely new problems, not the same numbers rearranged.
- Order them easier -> same -> harder, so there is a ramp.
- Each must be solvable with the skill named above, without needing a technique
  the student has not met yet.
- Include the correct answer for each. Answers are stored privately and shown
  only after the student submits.
- Keep the wording short enough to read on a phone.

Reply with JSON only.`;
}

/**
 * Instructions for reading a photographed page.
 *
 * @returns {string} The transcription system prompt.
 */
export function buildTranscriptionPrompt() {
  return `Read this photo of a student's page and transcribe what is on it.

- Find EVERY problem visible, not just the first. A textbook page usually holds
  several, and the student will pick which one they want help with.
- Keep the printed question numbers as "label" (e.g. "4a"). Use null if a
  problem is unnumbered.
- Transcribe mathematical notation faithfully using plain Unicode: x², √, ≤, π,
  ∫, Δ. Do not convert it to LaTeX.
- If the student's own handwritten working is visible, put it in
  studentWorking, separately from the printed questions. Do not correct it —
  transcribe exactly what they wrote, mistakes included, since spotting those
  mistakes is the entire point.
- If the image is too blurry or does not show schoolwork, return an empty
  problems array.

Reply with JSON only.`;
}
