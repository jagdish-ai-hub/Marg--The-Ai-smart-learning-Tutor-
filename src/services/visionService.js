/**
 * @file Reading a photo of a student's page.
 *
 * "Snap a photo of the page" is the fastest way into a session — nobody wants
 * to retype an integral on a phone keyboard at 11pm.
 *
 * One photo returns *every* problem on the page, not just one. A textbook page
 * holds six questions; making the student take six photos to get help with six
 * problems would be a strange thing to build.
 *
 * Transcription is deliberately a separate step from starting a session. The
 * student sees what was read, fixes anything the camera got wrong, and only
 * then commits — which beats discovering halfway through that Marg has been
 * solving `5` instead of `S`.
 */

import { generateStructured, getProviderChain } from '../ai/registry.js';
import { TranscriptionSchema, transcriptionJsonSchema } from '../ai/schemas.js';
import { buildTranscriptionPrompt } from '../prompts/tasks.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { isValidSubject } from '../data/subjects.js';
import { logger } from '../utils/logger.js';

/** Image formats the AI providers accept. */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

/**
 * Reads a photographed page and returns every problem on it.
 *
 * @param {object} options
 * @param {Buffer} options.buffer - The raw image bytes.
 * @param {string} options.mimeType - The image's MIME type.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @returns {Promise<{subjectId: string|null, problems: object[], studentWorking: string|null}>}
 * @throws {ApiError} `UPLOAD_REJECTED` for an unsupported format,
 *   `VISION_UNSUPPORTED` if the configured provider cannot read images.
 *
 * @example
 * const { problems } = await transcribeImage({ buffer, mimeType: 'image/jpeg' });
 * problems; // [{ label: '4a', text: 'Solve 2x² − 5x − 3 = 0' }, …]
 */
export async function transcribeImage({ buffer, mimeType, signal }) {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw ApiError.badRequest(
      ErrorCodes.UPLOAD_REJECTED,
      `That image format is not supported. Use one of: ${ALLOWED_MIME_TYPES.join(', ')}.`,
    );
  }

  const [provider] = getProviderChain();
  if (!provider.supportsVision) {
    throw new ApiError(
      501,
      ErrorCodes.VISION_UNSUPPORTED,
      `The configured AI provider (${provider.id}) cannot read images. Switch AI_PROVIDER to one that can, or type the problem in instead.`,
    );
  }

  const result = await generateStructured({
    schemaName: 'transcription',
    jsonSchema: transcriptionJsonSchema,
    zodSchema: TranscriptionSchema,
    system: buildTranscriptionPrompt(),
    messages: [{
      role: 'user',
      content: 'Transcribe every problem on this page.',
      images: [{ mimeType, data: buffer.toString('base64') }],
    }],
    temperature: 0, // Transcription is copying, not creating.
    maxTokens: 1500,
    signal,
  });

  // The model can invent a subject id that is not in our list; drop it rather
  // than letting an invalid value reach the client and fail validation later.
  const subjectId = result.subjectId && isValidSubject(result.subjectId) ? result.subjectId : null;

  logger.info('Image transcribed', { problems: result.problems.length, subjectId });

  return {
    subjectId,
    problems: result.problems,
    studentWorking: result.studentWorking,
  };
}
