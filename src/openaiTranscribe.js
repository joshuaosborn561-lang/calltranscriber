/**
 * Send audio bytes to OpenAI's transcription endpoint and return plain text.
 * Uses native fetch / FormData / Blob (Node 20+).
 */

export class OpenAIQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIQuotaError';
  }
}

export async function transcribeAudio(fileName, audioBuffer) {
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
      /insufficient_quota|credit_balance_exhausted|exceeded your current quota/i.test(
        body,
      )
    ) {
      throw new OpenAIQuotaError(
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
