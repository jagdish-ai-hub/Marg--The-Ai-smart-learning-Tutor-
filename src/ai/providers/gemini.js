/**
 * @file Google Gemini provider, talking to the REST API directly.
 *
 * No SDK on purpose: the REST endpoint is two URLs and a JSON body, and Node 20
 * has `fetch` built in. Skipping the SDK keeps installs small and means a
 * Google SDK release can never break this app.
 *
 * Docs: https://ai.google.dev/api/generate-content
 *
 * @example
 * import { geminiProvider } from './providers/gemini.js';
 * const reply = await geminiProvider.chat({
 *   system: 'You are a maths tutor.',
 *   messages: [{ role: 'user', content: 'What is a quadratic?' }],
 * });
 * console.log(reply.text);
 */

import { env } from '../../config/env.js';
import { postToProvider, readSseJson } from '../httpClient.js';
import { toGeminiSchema } from '../schemas.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Converts our provider-neutral request into Gemini's body format.
 *
 * Two differences worth knowing:
 *   - Gemini calls the AI's own turns `model`, not `assistant`.
 *   - The system prompt is a separate top-level `systemInstruction`, not a
 *     message with `role: 'system'`.
 *
 * @private
 * @param {import('../registry.js').ChatRequest} request - Provider-neutral request.
 * @returns {object} A Gemini request body.
 */
function buildBody(request) {
  const contents = request.messages.map((message) => {
    const parts = [];

    // Images must come before the text part — Gemini follows instructions about
    // an image far more reliably when it has already seen it.
    for (const image of message.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
    if (message.content) parts.push({ text: message.content });

    return { role: message.role === 'assistant' ? 'model' : 'user', parts };
  });

  const body = {
    contents,
    generationConfig: {
      temperature: request.temperature ?? 0.4,
      maxOutputTokens: request.maxTokens ?? 2048,
    },
  };

  if (request.system) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }

  // Structured output: Gemini guarantees the reply parses as JSON matching this
  // schema, which is far more reliable than asking nicely in the prompt.
  if (request.jsonSchema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = toGeminiSchema(request.jsonSchema.schema);
  }

  return body;
}

/**
 * Pulls the text out of a Gemini response, whatever shape it arrives in.
 *
 * @private
 * @param {object} payload - A Gemini API response object.
 * @returns {string} The concatenated text of all parts, or `''`.
 */
function extractText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((part) => part.text ?? '').join('');
}

/**
 * Normalises Gemini's token counts into our shared shape.
 *
 * @private
 * @param {object} payload - A Gemini API response object.
 * @returns {{ inputTokens: number, outputTokens: number }}
 */
function extractUsage(payload) {
  const usage = payload?.usageMetadata ?? {};
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

/**
 * Picks which Gemini model to use for a request.
 *
 * @private
 * @param {import('../registry.js').ChatRequest} request - The request.
 * @returns {string} A model name.
 */
function pickModel(request) {
  if (request.model) return request.model;
  // Cheap classification calls (triage) can run on a smaller model.
  if (request.tier === 'fast' && env.AI_MODEL_FAST) return env.AI_MODEL_FAST;
  return env.GEMINI_MODEL;
}

/**
 * The Gemini provider.
 *
 * @type {import('../registry.js').Provider}
 */
export const geminiProvider = {
  id: 'gemini',
  supportsVision: true,
  supportsStreaming: true,

  /**
   * Sends a request and waits for the complete reply.
   *
   * @param {import('../registry.js').ChatRequest} request - What to ask.
   * @returns {Promise<import('../registry.js').ChatResult>} The full reply.
   */
  async chat(request) {
    const model = pickModel(request);
    const response = await postToProvider(
      `${API_ROOT}/models/${model}:generateContent`,
      {
        body: buildBody(request),
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
        signal: request.signal,
        provider: 'gemini',
      },
    );

    const payload = await response.json();
    return {
      text: extractText(payload),
      usage: extractUsage(payload),
      model,
      provider: 'gemini',
    };
  },

  /**
   * Sends a request and yields the reply in pieces as it is generated.
   *
   * @param {import('../registry.js').ChatRequest} request - What to ask.
   * @yields {import('../registry.js').ChatChunk} `delta` chunks, then one `done`.
   * @returns {AsyncGenerator<import('../registry.js').ChatChunk>}
   */
  async *stream(request) {
    const model = pickModel(request);
    const response = await postToProvider(
      // `alt=sse` switches Gemini from a JSON array to real Server-Sent Events.
      // Without it you get one giant array at the end and no streaming at all.
      `${API_ROOT}/models/${model}:streamGenerateContent?alt=sse`,
      {
        body: buildBody(request),
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
        signal: request.signal,
        provider: 'gemini',
      },
    );

    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const payload of readSseJson(response)) {
      const text = extractText(payload);
      if (text) yield { type: 'delta', text };
      // Usage arrives on the final chunks; keep the most recent non-zero value.
      if (payload?.usageMetadata) usage = extractUsage(payload);
    }

    yield { type: 'done', usage, model, provider: 'gemini' };
  },
};
