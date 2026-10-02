/**
 * @file One provider for every service that speaks the OpenAI chat format.
 *
 * OpenRouter, Groq, Together, Fireworks, DeepInfra, Ollama, LM Studio and vLLM
 * all expose the same `POST /chat/completions` endpoint. That means a single
 * adapter covers all of them and switching between them is a change to
 * `.env`, not to code.
 *
 * This file is used for both `AI_PROVIDER=openrouter` and
 * `AI_PROVIDER=openai-compatible`; the only difference is where the base URL,
 * key, and model are read from.
 *
 * @example
 * // Point at Groq instead of OpenRouter, no code change:
 * //   AI_PROVIDER=openai-compatible
 * //   OPENAI_COMPATIBLE_BASE_URL=https://api.groq.com/openai/v1
 * //   OPENAI_COMPATIBLE_MODEL=llama-3.3-70b-versatile
 */

import { env } from '../../config/env.js';
import { postToProvider, readSseJson } from '../httpClient.js';
import { toOpenAiResponseFormat } from '../schemas.js';
import { ErrorCodes } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';

/**
 * Reads the right settings for whichever flavour of this provider is in use.
 *
 * @private
 * @param {string} flavour - Either `'openrouter'` or `'openai-compatible'`.
 * @returns {{ baseUrl: string, apiKey: string, model: string }}
 */
function settingsFor(flavour) {
  if (flavour === 'openrouter') {
    return {
      baseUrl: env.OPENROUTER_BASE_URL,
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL,
    };
  }
  return {
    baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
    apiKey: env.OPENAI_COMPATIBLE_API_KEY,
    model: env.OPENAI_COMPATIBLE_MODEL,
  };
}

/**
 * Converts our provider-neutral request into an OpenAI chat-completions body.
 *
 * The system prompt becomes an ordinary message with `role: 'system'`, and
 * images are sent as data URLs inside a multi-part `content` array.
 *
 * @private
 * @param {import('../registry.js').ChatRequest} request - Provider-neutral request.
 * @param {string} model - Model name to request.
 * @param {boolean} stream - Whether to ask for a streamed response.
 * @param {{ forceJsonObjectMode?: boolean }} [options] - Pass `forceJsonObjectMode: true`
 *   once this endpoint has told us it rejects strict `json_schema` mode.
 * @returns {object} A chat-completions request body.
 */
function buildBody(request, model, stream, { forceJsonObjectMode = false } = {}) {
  const messages = [];

  if (request.system) {
    messages.push({ role: 'system', content: request.system });
  }

  for (const message of request.messages) {
    if (message.images?.length) {
      // Multi-part content: images plus the text, in that order.
      const content = message.images.map((image) => ({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      }));
      if (message.content) content.push({ type: 'text', text: message.content });
      messages.push({ role: message.role, content });
    } else {
      messages.push({ role: message.role, content: message.content });
    }
  }

  const body = {
    model,
    messages,
    temperature: request.temperature ?? 0.4,
    max_tokens: request.maxTokens ?? 2048,
    stream,
  };

  // Ask for token counts on the final streaming chunk. Harmless on services
  // that do not support it — they simply ignore the field.
  if (stream) body.stream_options = { include_usage: true };

  if (request.jsonSchema) {
    // Strict `json_schema` mode is an OpenAI extension that not every
    // "OpenAI-compatible" endpoint actually implements (DeepSeek's API, for
    // one, returns a 400 for it). The plain `json_object` mode — just "give
    // me valid JSON" — is far more widely supported, and the prompts already
    // spell out the expected shape in prose, with jsonParse.js validating the
    // real schema afterward. See `chat()` below for when this gets used.
    body.response_format = forceJsonObjectMode
      ? { type: 'json_object' }
      : toOpenAiResponseFormat(request.jsonSchema.name, request.jsonSchema.schema);
  }

  return body;
}

/**
 * Builds the headers, including the two OpenRouter asks for so your app shows
 * up on its leaderboard. Both are optional and safe to send elsewhere.
 *
 * @private
 * @param {string} apiKey - The API key.
 * @param {string} flavour - Either `'openrouter'` or `'openai-compatible'`.
 * @returns {Record<string,string>}
 */
function buildHeaders(apiKey, flavour) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (flavour === 'openrouter') {
    headers['HTTP-Referer'] = 'https://marg.app';
    headers['X-Title'] = 'Marg — AI Tutor';
  }
  return headers;
}

/**
 * Normalises token counts into our shared shape.
 *
 * @private
 * @param {object} payload - A chat-completions response.
 * @returns {{ inputTokens: number, outputTokens: number }}
 */
function extractUsage(payload) {
  const usage = payload?.usage ?? {};
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
}

/**
 * Creates a provider bound to one flavour of OpenAI-compatible endpoint.
 *
 * @param {'openrouter'|'openai-compatible'} flavour - Which settings to read.
 * @returns {import('../registry.js').Provider} A ready-to-use provider.
 */
export function createOpenAiCompatibleProvider(flavour) {
  // Remembers, for the life of this provider instance, that this endpoint has
  // already told us it rejects strict `json_schema` mode — so every call after
  // the first failure skips straight to `json_object` mode instead of paying
  // for a request we already know will be rejected. Capability is a property
  // of the endpoint/account, not of any one request, so one instance-wide flag
  // is enough; it is not meant to track per-model support.
  let jsonSchemaUnsupported = false;

  return {
    id: flavour,
    // Whether images work depends on the model chosen, not the endpoint, so we
    // allow them and let the service complain if the model cannot cope.
    supportsVision: true,
    supportsStreaming: true,

    /**
     * Sends a request and waits for the complete reply.
     *
     * If structured output was requested and this endpoint rejects strict
     * `json_schema` mode (a real gap in some "OpenAI-compatible" APIs — see
     * `buildBody`), this retries once with the more widely supported
     * `json_object` mode before giving up.
     *
     * @param {import('../registry.js').ChatRequest} request - What to ask.
     * @returns {Promise<import('../registry.js').ChatResult>} The full reply.
     */
    async chat(request) {
      const { baseUrl, apiKey, model: defaultModel } = settingsFor(flavour);
      const model = request.model
        || (request.tier === 'fast' && env.AI_MODEL_FAST ? env.AI_MODEL_FAST : defaultModel);
      const url = `${baseUrl}/chat/completions`;
      const headers = buildHeaders(apiKey, flavour);

      let response;
      try {
        response = await postToProvider(url, {
          body: buildBody(request, model, false, { forceJsonObjectMode: jsonSchemaUnsupported }),
          headers,
          signal: request.signal,
          provider: flavour,
        });
      } catch (error) {
        const canFallBack = request.jsonSchema && !jsonSchemaUnsupported
          && error.code === ErrorCodes.PROVIDER_UNAVAILABLE && error.details?.status === 400;
        if (!canFallBack) throw error;

        jsonSchemaUnsupported = true;
        logger.warn('Provider rejected strict json_schema mode, falling back to json_object', {
          provider: flavour, model,
        });

        response = await postToProvider(url, {
          body: buildBody(request, model, false, { forceJsonObjectMode: true }),
          headers,
          signal: request.signal,
          provider: flavour,
        });
      }

      const payload = await response.json();
      return {
        text: payload?.choices?.[0]?.message?.content ?? '',
        usage: extractUsage(payload),
        model,
        provider: flavour,
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
      const { baseUrl, apiKey, model: defaultModel } = settingsFor(flavour);
      const model = request.model
        || (request.tier === 'fast' && env.AI_MODEL_FAST ? env.AI_MODEL_FAST : defaultModel);

      const response = await postToProvider(`${baseUrl}/chat/completions`, {
        body: buildBody(request, model, true, { forceJsonObjectMode: jsonSchemaUnsupported }),
        headers: buildHeaders(apiKey, flavour),
        signal: request.signal,
        provider: flavour,
      });

      let usage = { inputTokens: 0, outputTokens: 0 };

      for await (const payload of readSseJson(response)) {
        const text = payload?.choices?.[0]?.delta?.content;
        if (text) yield { type: 'delta', text };
        if (payload?.usage) usage = extractUsage(payload);
      }

      yield { type: 'done', usage, model, provider: flavour };
    },
  };
}
