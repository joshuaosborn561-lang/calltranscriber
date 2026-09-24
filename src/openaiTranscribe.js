import { splitMp3IntoChunks } from './audioConvert.js';

/**
 * Send audio bytes to OpenAI's transcription endpoint and return plain text.
 * Uses native fetch / FormData / Blob (Node 20+).
 * Long files are split into ~10 minute chunks when the model rejects them.
 */

export class OpenAIQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIQuotaError';
  }
}

export class OpenAIInputTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIInputTooLargeError';
  }
}

/** Chunk when longer than this many seconds (gpt-4o-mini-transcribe token limits). */
function getChunkThresholdSeconds() {
  const raw = process.env.TRANSCRIBE_CHUNK_SECONDS;
  const n = raw == null || raw === '' ? 600 : Number(raw);
  return Number.isFinite(n) && n > 60 ? n : 600;
}

export async function transcribeAudio(fileName, audioBuffer, { durationSeconds } = {}) {
  const chunkSeconds = getChunkThresholdSeconds();
  const shouldChunk =
    typeof durationSeconds === 'number' && durationSeconds > chunkSeconds;

  if (shouldChunk) {
    return transcribeInChunks(fileName, audioBuffer, chunkSeconds);
  }

  try {
    return await transcribeOnce(fileName, audioBuffer);
  } catch (err) {
    if (err instanceof OpenAIInputTooLargeError) {
      console.log(
        `Audio too large for model; splitting into ${chunkSeconds}s chunks: ${fileName}`,
      );
      return transcribeInChunks(fileName, audioBuffer, chunkSeconds);
    }
    throw err;
  }
}

async function transcribeInChunks(fileName, audioBuffer, chunkSeconds) {
  const chunks = await splitMp3IntoChunks(audioBuffer, fileName, chunkSeconds);
  console.log(`Transcribing ${chunks.length} chunk(s) for ${fileName}`);
  const parts = [];
  for (const chunk of chunks) {
    const text = await transcribeOnce(chunk.fileName, chunk.buffer);
    if (text?.trim()) parts.push(text.trim());
  }
  return parts.join('\n\n');
}

async function transcribeOnce(fileName, audioBuffer) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }

  const form = new FormData();
  const file = new File([audioBuffer], fileName, {
    type: guessMimeType(fileName),
  });
  form.append('file', file);
  form.append('model', 'gpt-4o-mini-transcribe');
  form.append('response_format', 'json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    if (
      res.status === 429 &&
      /insufficient_quota|credit_balance_exhausted|exceeded your current quota|project_spend_limit/i.test(
        body,
      )
    ) {
      throw new OpenAIQuotaError(
        `OpenAI transcription failed (${res.status}): ${body}`,
      );
    }
    if (res.status === 400 && /input_too_large|too large/i.test(body)) {
      throw new OpenAIInputTooLargeError(
        `OpenAI transcription failed (${res.status}): ${body}`,
      );
    }
    throw new Error(`OpenAI transcription failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  if (typeof data.text !== 'string') {
    throw new Error('OpenAI transcription response missing text field');
  }

  return data.text;
}

function guessMimeType(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.amr')) return 'audio/amr';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.flac')) return 'audio/flac';
  return 'application/octet-stream';
}
