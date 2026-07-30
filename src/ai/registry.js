/**
 * @file Picks the AI provider, retries when it makes sense, and falls back to a
 * second provider if the first one is down.
 *
 * Everything in `src/services/` talks to the AI through this file and never
 * imports a provider directly. That is what makes "switch from Gemini to
 * OpenRouter" a one-line change in `.env` rather than a refactor.
 *
 * @example
 * import { generateText, generateStructured } from '../ai/registry.js';
 *
 * // Free-form prose:
 * const reply = await generateText({ system: '...', messages: [...] });
 *
 * // Structured, validated data:
 * const plan = await generateStructured({
 *   schemaName: 'step_plan',
 *   jsonSchema: stepPlanJsonSchema,
 *   zodSchema: StepPlanSchema,
 *   system: '...',
 *   messages: [...],
 * });
 */

import { env } from '../config/env.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { parseJsonWithSchema } from './jsonParse.js';
import { geminiProvider } from './providers/gemini.js';
import { createOpenAiCompatibleProvider } from './providers/openaiCompatible.js';
import { mockProvider } from './providers/mock.js';

/**
 * One image attached to a message.
 *
 * @typedef {object} ImagePart
 * @property {string} mimeType - e.g. `'image/jpeg'`.
 * @property {string} data - The image bytes, base64-encoded, with no data-URL prefix.
 */

/**
 * One turn of conversation.
 *
 * @typedef {object} ChatMessage
 * @property {'user'|'assistant'} role - Who said it.
 * @property {string} content - The text.
 * @property {ImagePart[]} [images] - Optional images (user turns only).
 */

/**
 * A provider-neutral request. Every provider knows how to translate this into
 * its own format.
 *
 * @typedef {object} ChatRequest
 * @property {string} [system] - Instructions that frame the whole conversation.
 * @property {ChatMessage[]} messages - The conversation so far.
 * @property {number} [temperature=0.4] - Higher is more varied, lower more predictable.
 * @property {number} [maxTokens=2048] - Cap on reply length.
 * @property {{name: string, schema: object}} [jsonSchema] - Ask for structured output.
 * @property {AbortSignal} [signal] - Cancels the request when the client disconnects.
 * @property {'fast'|'main'} [tier='main'] - `fast` uses the cheaper model when configured.
 * @property {string} [model] - Force a specific model, ignoring the tier.
 */

/**
 * A completed reply.
 *
 * @typedef {object} ChatResult
 * @property {string} text - The reply text.
 * @property {{inputTokens: number, outputTokens: number}} usage - Token counts.
 * @property {string} model - Which model answered.
 * @property {string} provider - Which provider answered.
 */

/**
 * One piece of a streamed reply.
 *
 * @typedef {object} ChatChunk
 * @property {'delta'|'done'} type - `delta` carries text; `done` is the final summary.
 * @property {string} [text] - Present on `delta`.
 * @property {{inputTokens: number, outputTokens: number}} [usage] - Present on `done`.
 * @property {string} [model] - Present on `done`.
 * @property {string} [provider] - Present on `done`.
 */

/**
 * What every provider must implement.
 *
 * @typedef {object} Provider
 * @property {string} id - Provider name.
 * @property {boolean} supportsVision - Whether it accepts images.
 * @property {boolean} supportsStreaming - Whether `stream()` really streams.
 * @property {(request: ChatRequest) => Promise<ChatResult>} chat - Wait for the whole reply.
 * @property {(request: ChatRequest) => AsyncGenerator<ChatChunk>} stream - Reply in pieces.
 */

/** How many times to retry a failing provider before giving up on it. */
const MAX_ATTEMPTS = 3;

/** Providers are built lazily and cached, so config is only read once. */
const cache = new Map();

/**
 * Returns the provider with the given name, building it on first use.
 *
 * @param {string} name - `'gemini'`, `'openrouter'`, `'openai-compatible'`, or `'mock'`.
 * @returns {Provider} The provider.
 * @throws {ApiError} If the name is not recognised.
 */
export function getProvider(name) {
  if (cache.has(name)) return cache.get(name);

  let provider;
  switch (name) {
    case 'gemini':
      provider = geminiProvider;
      break;
    case 'openrouter':
      provider = createOpenAiCompatibleProvider('openrouter');
      break;
    case 'openai-compatible':
      provider = createOpenAiCompatibleProvider('openai-compatible');
      break;
    case 'mock':
      provider = mockProvider;
      break;
    default:
      throw ApiError.internal(`Unknown AI provider "${name}".`);
  }

  cache.set(name, provider);
  return provider;
}

/**
 * The providers to try, in order: the main one, then the fallback if configured.
 *
 * @returns {Provider[]} One or two providers.
 */
export function getProviderChain() {
  const chain = [getProvider(env.AI_PROVIDER)];
  if (env.AI_FALLBACK_PROVIDER && env.AI_FALLBACK_PROVIDER !== env.AI_PROVIDER) {
    chain.push(getProvider(env.AI_FALLBACK_PROVIDER));
  }
  return chain;
}

/**
 * Decides whether a failure is worth retrying.
 *
 * Rate limits and outages are temporary, so we retry. A rejected API key or a
 * malformed request will fail identically every time, so we surface it at once
 * rather than making the student wait through three pointless attempts.
 *
 * @private
 * @param {Error} error - The failure.
 * @returns {boolean} True when retrying might help.
 */
function isWorthRetrying(error) {
  if (error?.code === ErrorCodes.PROVIDER_TIMEOUT) return true;
  if (error?.code !== ErrorCodes.PROVIDER_UNAVAILABLE) return false;

  const status = error?.details?.status;
  // No status means the network itself failed — worth another go.
  if (!status) return true;
  return status === 429 || status >= 500;
}

/**
 * Pauses execution.
 *
 * @private
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs an operation against the provider chain, retrying and falling back.
 *
 * For each provider it tries up to {@link MAX_ATTEMPTS} times with exponential
 * backoff, then moves to the next provider. Only if everything fails does the
 * last error reach the caller.
 *
 * @private
 * @param {(provider: Provider) => Promise<any>} operation - What to run.
 * @param {AbortSignal} [signal] - Abort signal; cancellation stops everything at once.
 * @returns {Promise<any>} Whatever `operation` resolved to.
 * @throws {ApiError} The final failure if no provider succeeded.
 */
async function runWithFallback(operation, signal) {
  const chain = getProviderChain();
  let lastError;

  for (const provider of chain) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await operation(provider);
      } catch (error) {
        // The student closed the tab. Stop immediately; this is not a failure.
        if (signal?.aborted) throw error;

        lastError = error;

        if (!isWorthRetrying(error)) {
          logger.warn('AI provider failed permanently, moving on', {
            provider: provider.id,
            code: error.code,
          });
          break;
        }

        if (attempt < MAX_ATTEMPTS) {
          // 500ms, then 1000ms, then 2000ms.
          const delay = 500 * 2 ** (attempt - 1);
          logger.warn('AI provider failed, retrying', {
            provider: provider.id,
            attempt,
            delayMs: delay,
            code: error.code,
          });
          await wait(delay);
        }
      }
    }
    logger.warn('Giving up on provider', { provider: provider.id });
  }

  throw lastError ?? ApiError.provider(ErrorCodes.PROVIDER_UNAVAILABLE, 'No AI provider is available.');
}

/**
 * Asks the AI for a free-text reply.
 *
 * Use this for anything a student reads as prose — chat replies, hints,
 * explanations. Do not use it when you need data with a fixed shape; use
 * {@link generateStructured} for that.
 *
 * @param {ChatRequest} request - What to ask.
 * @returns {Promise<ChatResult>} The reply.
 * @throws {ApiError} `PROVIDER_UNAVAILABLE` or `PROVIDER_TIMEOUT` if every provider failed.
 */
export async function generateText(request) {
  return runWithFallback((provider) => provider.chat(request), request.signal);
}

/**
 * Asks the AI for structured data and validates it before returning.
 *
 * You get back either data that fully matches your Zod schema, or an error —
 * never a half-formed object that breaks something three functions later.
 *
 * @param {object} options
 * @param {string} options.schemaName - Short name, e.g. `'step_plan'`. Providers pass it through.
 * @param {object} options.jsonSchema - Plain JSON Schema from `src/ai/schemas.js`.
 * @param {import('zod').ZodType} options.zodSchema - Matching Zod schema for validation.
 * @param {string} [options.system] - System instructions.
 * @param {ChatMessage[]} options.messages - The conversation.
 * @param {number} [options.temperature=0.2] - Lower default: structured data should be predictable.
 * @param {number} [options.maxTokens] - Cap on reply length.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {'fast'|'main'} [options.tier='main'] - Which model tier to use.
 * @returns {Promise<any>} Data validated against `zodSchema`.
 * @throws {ApiError} `PROVIDER_BAD_RESPONSE` if the reply did not match the schema.
 */
export async function generateStructured({
  schemaName,
  jsonSchema,
  zodSchema,
  system,
  messages,
  temperature = 0.2,
  maxTokens,
  signal,
  tier = 'main',
}) {
  const result = await generateText({
    system,
    messages,
    temperature,
    maxTokens,
    signal,
    tier,
    jsonSchema: { name: schemaName, schema: jsonSchema },
  });

  const parsed = parseJsonWithSchema(result.text, zodSchema);
  if (!parsed.ok) {
    logger.error('AI returned unusable structured output', {
      schemaName,
      provider: result.provider,
      reason: parsed.reason,
      sample: result.text.slice(0, 300),
    });
    throw ApiError.provider(ErrorCodes.PROVIDER_BAD_RESPONSE, parsed.reason, {
      provider: result.provider,
      schema: schemaName,
    });
  }

  return parsed.data;
}

/**
 * Asks the AI for a reply and yields it in pieces.
 *
 * Note that fallback works differently here: once the first chunk has been sent
 * to the student we cannot silently switch providers, because they have already
 * seen the beginning of an answer. So fallback only applies to failures that
 * happen *before* any text arrives.
 *
 * @param {ChatRequest} request - What to ask.
 * @yields {ChatChunk} `delta` chunks followed by one `done`.
 * @returns {AsyncGenerator<ChatChunk>}
 */
export async function* streamText(request) {
  const chain = getProviderChain();
  let lastError;

  for (const provider of chain) {
    let produced = false;
    try {
      for await (const chunk of provider.stream(request)) {
        produced = true;
        yield chunk;
      }
      return;
    } catch (error) {
      if (request.signal?.aborted) return;

      // Already streaming — we cannot rewind what the student has seen.
      if (produced) throw error;

      lastError = error;
      logger.warn('Streaming provider failed before producing output', {
        provider: provider.id,
        code: error.code,
      });
    }
  }

  throw lastError ?? ApiError.provider(ErrorCodes.PROVIDER_UNAVAILABLE, 'No AI provider is available.');
}

/**
 * Describes the configured providers. Backs `GET /api/v1/meta/providers`, and
 * is handy when a frontend needs to know whether photo upload will work.
 *
 * @returns {{active: string, fallback: string|null, supportsVision: boolean, providers: object[]}}
 */
export function describeProviders() {
  const chain = getProviderChain();
  return {
    active: chain[0].id,
    fallback: chain[1]?.id ?? null,
    supportsVision: chain[0].supportsVision,
    providers: chain.map((provider) => ({
      id: provider.id,
      supportsVision: provider.supportsVision,
      supportsStreaming: provider.supportsStreaming,
    })),
  };
}
