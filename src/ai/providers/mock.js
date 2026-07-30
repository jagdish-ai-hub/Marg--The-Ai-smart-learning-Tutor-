/**
 * @file A fake AI provider that never calls the network.
 *
 * WHY THIS EXISTS
 * Two reasons, both practical:
 *
 *   1. **The frontend engineer can start immediately.** Set `AI_PROVIDER=mock`
 *      and every endpoint works, with realistic response shapes, before anyone
 *      has an API key or spends a rupee.
 *   2. **Tests are fast and deterministic.** The whole test suite runs offline
 *      and gives the same answer every time.
 *
 * Its replies are canned, not clever. It recognises the quadratic example used
 * throughout the docs, applies simple keyword rules for triage, and otherwise
 * returns sensible filler. Do not read anything into the tutoring quality here
 * — that comes from the real models.
 */

/**
 * Very small keyword classifier standing in for the real triage call.
 *
 * The heuristics below are deliberately crude. Their job is to make the mock
 * behave *plausibly* so that tests exercise the surrounding policy code — the
 * decision table in `guardService`, the reveal state machine in `tutorService`
 * — rather than to be any good at classification.
 *
 * @private
 * @param {string} text - The student's message.
 * @returns {object} A value matching `TriageSchema`.
 */
function mockTriage(text) {
  const lower = text.toLowerCase();

  const base = { subjectId: null, reason: 'mock provider heuristic' };

  // Questions about Marg itself are always allowed through.
  if (/\b(what can you do|who are you|how do (i|you) use|help me get started|what is marg|hello|hi there)\b/.test(lower)) {
    return {
      ...base,
      inScope: true,
      category: 'meta',
      integrityRisk: 'none',
      mode: 'discuss',
      wantsAnswer: false,
    };
  }

  // "Do it for me" phrasing — in scope academically, but wants the artifact.
  const wantsArtifact = /\b(write|do|complete|finish|solve all)\b.{0,30}\b(my|the)\b.{0,30}\b(essay|assignment|homework|coursework|report|paper|lab report|program|project)\b/.test(lower);
  if (wantsArtifact) {
    return {
      ...base,
      inScope: true,
      category: 'academic',
      integrityRisk: 'high',
      mode: 'explain',
      wantsAnswer: true,
    };
  }

  // Clearly non-academic creative or personal requests.
  if (/\b(song|poem for my|rap|joke|story about my|birthday message|instagram caption|love letter)\b/.test(lower)
      && !/\b(analyse|analyze|scan|meter|literary|translate|grammar)\b/.test(lower)) {
    return {
      ...base,
      inScope: false,
      category: 'off_topic',
      integrityRisk: 'none',
      mode: 'discuss',
      wantsAnswer: false,
    };
  }

  const wantsAnswer = /\b(just (tell|give)|the answer|what('| i)s the answer|solve it for me|show me the answer)\b/.test(lower);
  const isCheck = /\b(check|did i get|is this right|mark my|i got)\b/.test(lower);
  const isExplain = /\b(why|explain|how come|worked example|show me how)\b/.test(lower);

  return {
    ...base,
    inScope: true,
    category: 'academic',
    integrityRisk: 'none',
    mode: isCheck ? 'check' : isExplain ? 'explain' : wantsAnswer ? 'explain' : 'guide',
    wantsAnswer,
  };
}

/**
 * A canned step plan. Recognises the quadratic used in the docs so the
 * end-to-end walkthrough produces exactly what the screenshots show.
 *
 * @private
 * @param {string} problem - The problem text.
 * @returns {object} A value matching `StepPlanSchema`.
 */
function mockStepPlan(problem) {
  if (/2x.{0,3}2?\s*[-−]\s*5x\s*[-−]\s*3/.test(problem) || /quadratic/i.test(problem)) {
    return {
      title: 'Quadratic equations',
      topic: 'Factoring quadratics',
      restatedProblem: 'solve 2x² − 5x − 3 = 0',
      steps: [
        { instruction: 'Factor the quadratic into two brackets.', skill: 'factoring' },
        { instruction: 'Set each factor equal to zero.', skill: 'zero-product-property' },
        { instruction: 'Solve each small equation for x.', skill: 'linear-equations' },
      ],
      finalAnswer: 'x = −1/2 or x = 3',
    };
  }

  return {
    title: 'Practice problem',
    topic: 'General problem solving',
    restatedProblem: problem.slice(0, 200),
    steps: [
      { instruction: 'Write down what you are given and what you need to find.', skill: 'problem-setup' },
      { instruction: 'Choose the method or formula that connects them.', skill: 'method-selection' },
      { instruction: 'Work through the calculation carefully.', skill: 'execution' },
    ],
    finalAnswer: '(the mock provider does not compute real answers — set a real AI_PROVIDER)',
  };
}

/**
 * A canned marking result. Recognises the sign error from the docs example.
 *
 * @private
 * @param {string} prompt - The full prompt, which contains the student's attempt.
 * @returns {object} A value matching `MarkingSchema`.
 */
function mockMarking(prompt) {
  // The documented example: the student writes x = 1/2 or x = -3, flipping both
  // signs. This is the exact case the screenshots illustrate.
  if (/x\s*=\s*1\/2/.test(prompt) && /x\s*=\s*[-−]\s*3/.test(prompt)) {
    return {
      overall: 'incorrect',
      firstBrokenStepIndex: 3,
      steps: [
        { index: 1, verdict: 'correct', comment: 'The factoring is right — (2x + 1)(x − 3).' },
        { index: 2, verdict: 'correct', comment: 'You set both factors to zero correctly.' },
        {
          index: 3,
          verdict: 'incorrect',
          comment: 'Both signs came out backwards when you solved each bracket.',
        },
      ],
      errorType: 'sign_error',
      errorSummary: 'Signs flipped when solving each factor for x.',
      nudge: 'Take 2x + 1 = 0 on its own. If you subtract 1 from both sides first, what is x?',
    };
  }

  return {
    overall: 'partially_correct',
    firstBrokenStepIndex: 2,
    steps: [
      { index: 1, verdict: 'correct', comment: 'Good start — the setup is right.' },
      { index: 2, verdict: 'incorrect', comment: 'Something went wrong in this step.' },
    ],
    errorType: 'arithmetic_slip',
    errorSummary: 'An arithmetic slip partway through.',
    nudge: 'Re-check the arithmetic in the middle step, one operation at a time.',
  };
}

/**
 * Chooses canned structured data based on which schema was requested.
 *
 * @private
 * @param {import('../registry.js').ChatRequest} request - The request.
 * @returns {string} JSON text matching the requested schema.
 */
function respondWithJson(request) {
  const lastMessage = request.messages.at(-1)?.content ?? '';

  switch (request.jsonSchema.name) {
    case 'triage':
      return JSON.stringify(mockTriage(lastMessage));

    case 'step_plan':
      return JSON.stringify(mockStepPlan(lastMessage));

    case 'marking':
      return JSON.stringify(mockMarking(lastMessage));

    case 'practice':
      return JSON.stringify({
        skill: 'factoring',
        problems: [
          { prompt: 'Solve x² − 5x + 6 = 0', difficulty: 'easier', answer: 'x = 2 or x = 3' },
          { prompt: 'Solve 3x² + 5x − 2 = 0', difficulty: 'same', answer: 'x = 1/3 or x = −2' },
          { prompt: 'Solve 6x² − 7x − 3 = 0', difficulty: 'harder', answer: 'x = 3/2 or x = −1/3' },
        ],
      });

    case 'transcription':
      return JSON.stringify({
        subjectId: 'mathematics',
        problems: [
          { label: '4a', text: 'Solve 2x² − 5x − 3 = 0' },
          { label: '4b', text: 'Solve x² + 4x + 4 = 0' },
        ],
        studentWorking: null,
      });

    default:
      return '{}';
  }
}

/**
 * Chooses canned prose based on what the prompt is asking for.
 *
 * @private
 * @param {import('../registry.js').ChatRequest} request - The request.
 * @returns {string} A plausible tutor reply.
 */
function respondWithProse(request) {
  const system = request.system ?? '';
  const lastMessage = request.messages.at(-1)?.content ?? '';

  if (/HINT REQUEST/i.test(system) || /hint/i.test(lastMessage)) {
    return 'Look closely at the sign in front of the constant. What has to multiply together to give −3?';
  }
  if (/REVEAL/i.test(system)) {
    return 'Here is the full working.\n\n1. Factor: (2x + 1)(x − 3) = 0\n2. Set each factor to zero: 2x + 1 = 0, and x − 3 = 0\n3. Solve each one: x = −1/2, and x = 3\n\nSo x = −1/2 or x = 3. The part worth remembering: dividing by a negative flips the sign.';
  }
  if (/sign flip/i.test(lastMessage)) {
    return 'Because you divided by a negative — that flips the direction of the sign. Try that step again and watch what happens to the −1.';
  }

  return 'Let us take this one step at a time. Start with the first step on the card and tell me what you get — I will check it with you.';
}

/**
 * The mock provider.
 *
 * @type {import('../registry.js').Provider}
 */
export const mockProvider = {
  id: 'mock',
  supportsVision: true,
  supportsStreaming: true,

  /**
   * Returns a canned reply immediately.
   *
   * @param {import('../registry.js').ChatRequest} request - What to ask.
   * @returns {Promise<import('../registry.js').ChatResult>} A canned reply.
   */
  async chat(request) {
    const text = request.jsonSchema ? respondWithJson(request) : respondWithProse(request);
    return {
      text,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'mock',
      provider: 'mock',
    };
  },

  /**
   * Yields a canned reply a few words at a time, so streaming clients can be
   * developed and tested without a real provider.
   *
   * @param {import('../registry.js').ChatRequest} request - What to ask.
   * @yields {import('../registry.js').ChatChunk} `delta` chunks, then one `done`.
   * @returns {AsyncGenerator<import('../registry.js').ChatChunk>}
   */
  async *stream(request) {
    const { chunkText } = await import('../../utils/sse.js');
    const text = request.jsonSchema ? respondWithJson(request) : respondWithProse(request);

    for (const chunk of chunkText(text, 4)) {
      if (request.signal?.aborted) return;
      yield { type: 'delta', text: chunk };
    }

    yield {
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'mock',
      provider: 'mock',
    };
  },
};
