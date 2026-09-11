/**
 * Transcription provider router.
 * Default: assemblyai when ASSEMBLYAI_API_KEY is set, else openai.
 */

import {
  AssemblyAIQuotaError,
  transcribeWithAssemblyAI,
} from './assemblyaiTranscribe.js';
import {
  OpenAIQuotaError,
  transcribeAudio as transcribeWithOpenAI,
} from './openaiTranscribe.js';

export { AssemblyAIQuotaError, OpenAIQuotaError };

/** True when the provider reports credits / spend limit exhausted. */
export class TranscriptionQuotaError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'TranscriptionQuotaError';
    this.cause = cause;
  }
}

export function getTranscribeProvider() {
  const raw = process.env.TRANSCRIBE_PROVIDER?.trim().toLowerCase();
  if (raw === 'openai' || raw === 'assemblyai') return raw;
  if (process.env.ASSEMBLYAI_API_KEY?.trim()) return 'assemblyai';
  if (process.env.OPENAI_API_KEY?.trim()) return 'openai';
  throw new Error(
    'No transcription provider configured. Set ASSEMBLYAI_API_KEY (preferred) or OPENAI_API_KEY.',
  );
}

/**
 * @param {string} fileName
 * @param {Buffer} audioBuffer
 * @param {{ durationSeconds?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function transcribeAudio(fileName, audioBuffer, opts = {}) {
  const provider = getTranscribeProvider();
  try {
    if (provider === 'assemblyai') {
      return await transcribeWithAssemblyAI(fileName, audioBuffer);
    }
    return await transcribeWithOpenAI(fileName, audioBuffer, opts);
  } catch (err) {
    if (
      err instanceof OpenAIQuotaError ||
      err instanceof AssemblyAIQuotaError
    ) {
      throw new TranscriptionQuotaError(err.message, err);
    }
    throw err;
  }
}
